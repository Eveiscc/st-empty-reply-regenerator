import {
    chat,
    eventSource,
    event_types,
    isGenerating,
    saveChatConditional,
    saveSettingsDebounced,
} from '/script.js';
import { extension_settings } from '/scripts/extensions.js';

(function () {
    'use strict';

    const extensionKey = 'empty_reply_regenerator';
    const retryCountExtraKey = 'empty_reply_regenerator_retry_count';
    const settingsPanelId = `${extensionKey}_settings`;
    const enabledInputId = `${extensionKey}_enabled`;
    const maxRetriesInputId = `${extensionKey}_max_retries`;
    const rpmLimitInputId = `${extensionKey}_rpm_limit`;
    const statusId = `${extensionKey}_status`;
    const retryCounterClass = 'empty-reply-regenerator-retry-counter';
    const defaultSettings = Object.freeze({
        enabled: true,
        maxRetries: 2,
        rpmLimit: 0,
    });
    const eligibleGenerationTypes = new Set(['normal', 'regenerate']);
    const blankCharacters = /[\u200B-\u200D\u2060\uFEFF]/g;

    let retryCount = 0;
    let pendingAutoRetry = false;
    let pendingAutoRetryTimer = null;
    let generationStopped = false;
    let activeGenerationType = null;
    let scheduledCheck = null;
    let rpmResumeTimer = null;
    let retryRequestTimestamps = [];
    let lastHandledEmptyKey = '';

    function getSettings() {
        if (!extension_settings[extensionKey] || typeof extension_settings[extensionKey] !== 'object') {
            extension_settings[extensionKey] = {};
        }

        const settings = extension_settings[extensionKey];
        if (typeof settings.enabled !== 'boolean') {
            settings.enabled = defaultSettings.enabled;
        }

        settings.maxRetries = normalizeMaxRetries(settings.maxRetries);
        settings.rpmLimit = normalizeRpmLimit(settings.rpmLimit);
        return settings;
    }

    function normalizeMaxRetries(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) {
            return defaultSettings.maxRetries;
        }

        return Math.max(0, Math.min(200, Math.trunc(number)));
    }

    function normalizeRpmLimit(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) {
            return defaultSettings.rpmLimit;
        }

        return Math.max(0, Math.min(120, Math.trunc(number)));
    }

    function saveSettings() {
        saveSettingsDebounced();
    }

    function setStatus(text) {
        const status = document.getElementById(statusId);
        if (status) {
            status.textContent = text;
        }
    }

    function isGenerationStillActive() {
        const stopButton = document.getElementById('mes_stop');
        const stopButtonVisible = !!stopButton && getComputedStyle(stopButton).display !== 'none';
        return isGenerating() || document.body.dataset.generating === 'true' || stopButtonVisible;
    }

    function getReplyText(message) {
        return String(message?.mes ?? '').replace(blankCharacters, '').trim();
    }

    function getMessageKey(index, message) {
        return [
            index,
            message?.send_date ?? '',
            message?.gen_started ?? '',
            message?.gen_finished ?? '',
            message?.swipe_id ?? '',
        ].join('|');
    }

    function isCompletedAiReply(message) {
        return !!message && !message.is_user && !message.is_system && !!message.gen_finished;
    }

    function isEligibleEmptyReply(message) {
        return isCompletedAiReply(message) && getReplyText(message).length === 0;
    }

    function shouldCheckGenerationType() {
        return activeGenerationType === null || eligibleGenerationTypes.has(activeGenerationType);
    }

    function pruneRetryRequestTimestamps(now = Date.now()) {
        const windowStart = now - 60000;
        retryRequestTimestamps = retryRequestTimestamps.filter(timestamp => timestamp > windowStart);
    }

    function getRetryResumeDelay(settings, now = Date.now()) {
        pruneRetryRequestTimestamps(now);
        if (!settings.rpmLimit || retryRequestTimestamps.length < settings.rpmLimit) {
            return 0;
        }

        return Math.max(0, retryRequestTimestamps[0] + 60000 - now);
    }

    function scheduleRpmResume(delay) {
        if (rpmResumeTimer) {
            clearTimeout(rpmResumeTimer);
        }

        rpmResumeTimer = setTimeout(() => {
            rpmResumeTimer = null;
            scheduleEmptyReplyCheck('rpm_limit_released');
        }, delay + 100);
    }

    function formatDelay(milliseconds) {
        return `${Math.max(1, Math.ceil(milliseconds / 1000))} 秒`;
    }

    function getStoredRetryCount(message) {
        const count = Number(message?.extra?.[retryCountExtraKey] ?? 0);
        return Number.isInteger(count) && count > 0 ? count : 0;
    }

    function renderRetryCounter(messageIndex) {
        const message = chat[messageIndex];
        const messageElement = document.querySelector(`#chat .mes[mesid="${messageIndex}"]`);
        const container = messageElement?.querySelector('.mesAvatarWrapper');

        if (!messageElement || !container) {
            return;
        }

        let counter = messageElement.querySelector(`.${retryCounterClass}`);
        const count = getStoredRetryCount(message);

        if (!count) {
            counter?.remove();
            return;
        }

        if (!counter) {
            counter = document.createElement('div');
            counter.className = retryCounterClass;
            const anchor = container.querySelector('.tokenCounterDisplay')
                || container.querySelector('.mes_timer')
                || container.lastElementChild;

            if (anchor) {
                anchor.insertAdjacentElement('afterend', counter);
            } else {
                container.append(counter);
            }
        }

        counter.textContent = `空回重试 ${count} 次`;
        counter.title = `本楼由空回自动重试 ${count} 次生成`;
    }

    function renderAllRetryCounters() {
        document.querySelectorAll('#chat .mes[mesid]').forEach(element => {
            const messageIndex = Number(element.getAttribute('mesid'));
            if (Number.isInteger(messageIndex)) {
                renderRetryCounter(messageIndex);
            }
        });
    }

    async function recordRetryCountOnFinalReply(messageIndex, message) {
        if (retryCount <= 0 || !isCompletedAiReply(message) || getReplyText(message).length === 0) {
            return false;
        }

        if (!message.extra || typeof message.extra !== 'object') {
            message.extra = {};
        }

        message.extra[retryCountExtraKey] = retryCount;
        renderRetryCounter(messageIndex);
        await saveChatConditional();
        resetRetrySession();
        setStatus('');
        return true;
    }

    function scheduleEmptyReplyCheck(reason) {
        if (scheduledCheck) {
            clearTimeout(scheduledCheck);
        }

        scheduledCheck = setTimeout(() => {
            scheduledCheck = null;
            void checkForEmptyReply(reason);
        }, 300);
    }

    async function checkForEmptyReply(reason) {
        const settings = getSettings();
        if (!settings.enabled || generationStopped || isGenerationStillActive() || !shouldCheckGenerationType()) {
            return;
        }

        const messageIndex = chat.length - 1;
        const lastMessage = chat[messageIndex];

        if (!isEligibleEmptyReply(lastMessage)) {
            await recordRetryCountOnFinalReply(messageIndex, lastMessage);
            return;
        }

        const messageKey = getMessageKey(messageIndex, lastMessage);
        if (messageKey === lastHandledEmptyKey) {
            return;
        }

        if (retryCount >= settings.maxRetries) {
            lastHandledEmptyKey = messageKey;
            setStatus(`检测到空回，但已达到重试上限（${settings.maxRetries}）`);
            return;
        }

        const resumeDelay = getRetryResumeDelay(settings);
        if (resumeDelay > 0) {
            setStatus(`检测到空回；已达到每分钟自动重试上限，约 ${formatDelay(resumeDelay)} 后继续`);
            scheduleRpmResume(resumeDelay);
            return;
        }

        retryCount += 1;
        lastHandledEmptyKey = messageKey;
        setStatus(`检测到空回，正在重新生成 ${retryCount}/${settings.maxRetries}`);
        triggerRegenerate(reason);
    }

    function triggerRegenerate(reason) {
        const regenerateButton = document.getElementById('option_regenerate');
        if (!regenerateButton) {
            setStatus('未找到重新生成按钮');
            return;
        }

        pendingAutoRetry = true;
        if (pendingAutoRetryTimer) {
            clearTimeout(pendingAutoRetryTimer);
        }

        pendingAutoRetryTimer = setTimeout(() => {
            pendingAutoRetry = false;
            pendingAutoRetryTimer = null;
        }, 5000);

        console.info(`[${extensionKey}] Empty reply after ${reason}; triggering regenerate.`);
        retryRequestTimestamps.push(Date.now());
        pruneRetryRequestTimestamps();
        regenerateButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }

    function resetRetrySession() {
        retryCount = 0;
        pendingAutoRetry = false;
        generationStopped = false;
        activeGenerationType = null;
        lastHandledEmptyKey = '';

        if (pendingAutoRetryTimer) {
            clearTimeout(pendingAutoRetryTimer);
            pendingAutoRetryTimer = null;
        }

        if (rpmResumeTimer) {
            clearTimeout(rpmResumeTimer);
            rpmResumeTimer = null;
        }
    }

    function onGenerationStarted(type) {
        activeGenerationType = type || 'normal';
        generationStopped = false;

        if (pendingAutoRetry) {
            pendingAutoRetry = false;
            if (pendingAutoRetryTimer) {
                clearTimeout(pendingAutoRetryTimer);
                pendingAutoRetryTimer = null;
            }
            return;
        }

        retryCount = 0;
        lastHandledEmptyKey = '';
        setStatus('');
    }

    function injectSettingsPanel() {
        if (document.getElementById(settingsPanelId)) {
            return;
        }

        const container = document.querySelector('#extensions_settings2')
            || document.querySelector('#extensions_settings')
            || document.querySelector('.extensions_settings');

        if (!container) {
            setTimeout(injectSettingsPanel, 500);
            return;
        }

        const settings = getSettings();
        container.insertAdjacentHTML('beforeend', `
            <div class="extension-settings" id="${settingsPanelId}">
                <div class="inline-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header">
                        <b>空回自动重生成</b>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    </div>
                    <div class="inline-drawer-content">
                        <label class="checkbox_label empty-reply-regenerator-enabled" for="${enabledInputId}">
                            <input id="${enabledInputId}" type="checkbox">
                            <span>检测到空回时自动重新生成（仅在生成结束后检查正文是否为空）</span>
                        </label>
                        <div class="empty-reply-regenerator-row">
                            <label for="${maxRetriesInputId}">每轮最大重试次数</label>
                            <input id="${maxRetriesInputId}" class="text_pole empty-reply-regenerator-number" type="number" min="0" max="200" step="1">
                        </div>
                        <div class="empty-reply-regenerator-row">
                            <label for="${rpmLimitInputId}">每分钟最大自动重试次数（RPM：每分钟请求数，0 为不限）</label>
                            <input id="${rpmLimitInputId}" class="text_pole empty-reply-regenerator-number" type="number" min="0" max="120" step="1">
                        </div>
                        <div id="${statusId}" class="empty-reply-regenerator-status"></div>
                    </div>
                </div>
            </div>
        `);

        const enabledInput = document.getElementById(enabledInputId);
        const maxRetriesInput = document.getElementById(maxRetriesInputId);
        const rpmLimitInput = document.getElementById(rpmLimitInputId);
        enabledInput.checked = settings.enabled;
        maxRetriesInput.value = String(settings.maxRetries);
        rpmLimitInput.value = String(settings.rpmLimit);
        setStatus('');

        enabledInput.addEventListener('change', () => {
            const currentSettings = getSettings();
            currentSettings.enabled = enabledInput.checked;
            setStatus('');
            saveSettings();
        });

        maxRetriesInput.addEventListener('change', () => {
            const currentSettings = getSettings();
            currentSettings.maxRetries = normalizeMaxRetries(maxRetriesInput.value);
            maxRetriesInput.value = String(currentSettings.maxRetries);
            saveSettings();
        });

        rpmLimitInput.addEventListener('change', () => {
            const currentSettings = getSettings();
            currentSettings.rpmLimit = normalizeRpmLimit(rpmLimitInput.value);
            rpmLimitInput.value = String(currentSettings.rpmLimit);
            saveSettings();
        });
    }

    function init() {
        getSettings();
        injectSettingsPanel();
        renderAllRetryCounters();

        eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
        eventSource.on(event_types.GENERATION_STOPPED, () => {
            generationStopped = true;
            pendingAutoRetry = false;
        });
        eventSource.on(event_types.GENERATION_ENDED, () => scheduleEmptyReplyCheck('generation_ended'));
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId, type) => {
            if (type) {
                activeGenerationType = type;
            }
            renderRetryCounter(Number(messageId));
            scheduleEmptyReplyCheck('character_message_rendered');
        });
        eventSource.on(event_types.GROUP_WRAPPER_FINISHED, () => scheduleEmptyReplyCheck('group_wrapper_finished'));
        eventSource.on(event_types.CHAT_CHANGED, () => {
            resetRetrySession();
            setTimeout(renderAllRetryCounters, 300);
        });
        eventSource.on(event_types.MORE_MESSAGES_LOADED, renderAllRetryCounters);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
