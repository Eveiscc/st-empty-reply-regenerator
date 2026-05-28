import {
    chat,
    eventSource,
    event_types,
    is_send_press,
    saveChatConditional,
    saveSettingsDebounced,
} from '/script.js';
import { extension_settings } from '/scripts/extensions.js';
import { is_group_generating } from '/scripts/group-chats.js';

(function () {
    'use strict';

    const extensionKey = 'empty_reply_regenerator';
    const retryCountExtraKey = 'empty_reply_regenerator_retry_count';
    const settingsPanelId = `${extensionKey}_settings`;
    const enabledInputId = `${extensionKey}_enabled`;
    const maxRetriesInputId = `${extensionKey}_max_retries`;
    const rpmLimitInputId = `${extensionKey}_rpm_limit`;
    const imageAssistEnabledInputId = `${extensionKey}_image_assist_enabled`;
    const imageAssistMaxRetriesInputId = `${extensionKey}_image_assist_max_retries`;
    const statusId = `${extensionKey}_status`;
    const lastStatusId = `${extensionKey}_last_status`;
    const imageStatusId = `${extensionKey}_image_status`;
    const toastLogId = `${extensionKey}_toast_log`;
    const retryCounterClass = 'empty-reply-regenerator-retry-counter';
    const metadataTextPattern = /字数\s*\S+[\s|｜]*更新于/;
    const maxToastLogEntries = 3;
    const toastRetryCheckDelays = Object.freeze([700, 1800]);
    const imageAssistClickableSelector = 'button, .menu_button, [role="button"], input[type="button"], input[type="submit"], a';
    const imageAssistMediaSelector = '.mes_text img, .mes_text video, .mes_text canvas, .mes_text picture';
    const imageAssistRetryCheckInterval = 2000;
    const imageAssistSessionTtl = 10 * 60 * 1000;
    const defaultSettings = Object.freeze({
        enabled: true,
        maxRetries: 5,
        rpmLimit: 3,
        imageAssistEnabled: false,
        imageAssistMaxRetries: 3,
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
    let generationStartChatLength = 0;
    let generationStartLastMessageKey = '';
    let generationRequestSubmitted = false;
    let generationRequestId = 0;
    let toastLogEntries = [];
    let toastContainerObserver = null;
    let toastBodyObserver = null;
    let observedToastContainer = null;
    let toastRetryCheckTimers = [];
    let imageAssistSession = null;
    let imageAssistRetryTimer = null;
    let imageAssistObserver = null;
    let imageAssistExpireTimer = null;
    const recordedToastElements = new WeakSet();

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
        if (typeof settings.imageAssistEnabled !== 'boolean') {
            settings.imageAssistEnabled = defaultSettings.imageAssistEnabled;
        }
        settings.imageAssistMaxRetries = normalizeImageAssistMaxRetries(settings.imageAssistMaxRetries);
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

    function normalizeImageAssistMaxRetries(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) {
            return defaultSettings.imageAssistMaxRetries;
        }

        return Math.max(0, Math.min(20, Math.trunc(number)));
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

    function setLastStatus(text) {
        const status = document.getElementById(lastStatusId);
        if (status) {
            status.textContent = text ? `最近检测：${text}` : '';
        }
    }

    function setImageStatus(text) {
        const status = document.getElementById(imageStatusId);
        if (status) {
            const nextText = text ? `最近生图：${text}` : '';
            if (status.textContent !== nextText) {
                status.textContent = nextText;
            }
        }
    }

    function renderToastLog() {
        const log = document.getElementById(toastLogId);
        if (!log) {
            return;
        }

        log.textContent = toastLogEntries.length > 0
            ? `最近弹窗：\n${toastLogEntries.map(entry => `${entry.time} ${entry.text}`).join('\n')}`
            : '';
    }

    function padTimePart(value) {
        return String(value).padStart(2, '0');
    }

    function formatLogTime(date = new Date()) {
        return `${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}:${padTimePart(date.getSeconds())}`;
    }

    function normalizeToastText(text) {
        return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    }

    function shortenStatusText(text, limit = 80) {
        const normalized = normalizeToastText(text);
        return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
    }

    function getToastKind(element) {
        if (element.classList.contains('toast-error')) {
            return '错误';
        }

        if (element.classList.contains('toast-warning')) {
            return '警告';
        }

        return '';
    }

    function getToastText(element) {
        const title = normalizeToastText(element.querySelector('.toast-title')?.textContent);
        const message = normalizeToastText(element.querySelector('.toast-message')?.textContent);
        return [title, message].filter(Boolean).join('：') || normalizeToastText(element.textContent);
    }

    function isGenerationStillActive() {
        const stopButton = document.getElementById('mes_stop');
        const stopButtonVisible = !!stopButton && getComputedStyle(stopButton).display !== 'none';
        return is_send_press || is_group_generating || document.body.dataset.generating === 'true' || stopButtonVisible;
    }

    function getReplyText(message) {
        return String(message?.mes ?? '').replace(blankCharacters, '').trim();
    }

    function getReplyLength(message) {
        return getReplyText(message).length;
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

    function getCurrentLastMessageKey() {
        const index = chat.length - 1;
        return getMessageKey(index, chat[index]);
    }

    function formatMessageIndex(index) {
        return Number.isInteger(index) && index >= 0 ? `第 ${index} 楼` : '最后一楼';
    }

    function isCompletedAiReply(message) {
        return !!message && !message.is_user && !message.is_system && !!message.gen_finished;
    }

    function isEligibleEmptyReply(message) {
        return isCompletedAiReply(message) && getReplyText(message).length === 0;
    }

    function hasNoGeneratedReplyChange() {
        if (!generationRequestSubmitted || chat.length <= 0 || generationStartChatLength <= 0) {
            return false;
        }

        return chat.length === generationStartChatLength
            && getCurrentLastMessageKey() === generationStartLastMessageKey;
    }

    function getEmptyReplyCandidate(messageIndex, message) {
        if (isEligibleEmptyReply(message)) {
            return {
                key: getMessageKey(messageIndex, message),
                label: `${formatMessageIndex(messageIndex)}正文为空`,
            };
        }

        if (hasNoGeneratedReplyChange()) {
            return {
                key: `no-ai-reply|${generationRequestId}|${generationStartLastMessageKey}`,
                label: '本轮没有生成新的 AI 回复',
            };
        }

        return null;
    }

    function shouldCheckGenerationType() {
        return activeGenerationType === null || eligibleGenerationTypes.has(activeGenerationType);
    }

    function markGenerationCheckpointFromCurrentChat() {
        generationRequestSubmitted = true;
        generationRequestId += 1;
        generationStartChatLength = chat.length;
        generationStartLastMessageKey = getCurrentLastMessageKey();
    }

    function markToastFailureCheckpointIfNeeded() {
        if (generationRequestSubmitted || generationStopped || activeGenerationType === null || !shouldCheckGenerationType()) {
            return;
        }

        const lastMessage = chat[chat.length - 1];
        if (activeGenerationType === 'regenerate' || lastMessage?.is_user) {
            markGenerationCheckpointFromCurrentChat();
        }
    }

    function clearToastRetryChecks() {
        toastRetryCheckTimers.forEach(timer => clearTimeout(timer));
        toastRetryCheckTimers = [];
    }

    function scheduleToastRetryChecks() {
        if (!getSettings().enabled || generationStopped || !generationRequestSubmitted) {
            return;
        }

        clearToastRetryChecks();
        toastRetryCheckTimers = toastRetryCheckDelays.map(delay => setTimeout(() => {
            scheduleEmptyReplyCheck('toast_error');
        }, delay));
    }

    function recordToastElement(element) {
        if (!(element instanceof HTMLElement) || recordedToastElements.has(element)) {
            return;
        }

        const kind = getToastKind(element);
        if (!kind) {
            return;
        }

        recordedToastElements.add(element);
        const text = getToastText(element);
        if (!text) {
            return;
        }

        toastLogEntries.unshift({
            time: formatLogTime(),
            text: `${kind}：${text}`,
        });
        toastLogEntries = toastLogEntries.slice(0, maxToastLogEntries);
        renderToastLog();
        handleImageAssistToast(kind, text);
        markToastFailureCheckpointIfNeeded();
        scheduleToastRetryChecks();
    }

    function observeToastContainer(container) {
        if (!(container instanceof HTMLElement) || observedToastContainer === container) {
            return;
        }

        if (toastContainerObserver) {
            toastContainerObserver.disconnect();
        }

        observedToastContainer = container;
        Array.from(container.children).forEach(recordToastElement);
        toastContainerObserver = new MutationObserver(mutations => {
            mutations.forEach(mutation => {
                mutation.addedNodes.forEach(node => {
                    if (node instanceof HTMLElement) {
                        if (node.classList.contains('toast')) {
                            recordToastElement(node);
                        }
                        node.querySelectorAll?.('.toast').forEach(recordToastElement);
                    }
                });
            });
        });
        toastContainerObserver.observe(container, { childList: true });
    }

    function initToastObserver() {
        observeToastContainer(document.getElementById('toast-container'));

        if (toastBodyObserver || !document.body) {
            return;
        }

        toastBodyObserver = new MutationObserver(mutations => {
            mutations.forEach(mutation => {
                mutation.addedNodes.forEach(node => {
                    if (node instanceof HTMLElement && node.id === 'toast-container') {
                        observeToastContainer(node);
                    }
                });
            });
        });
        toastBodyObserver.observe(document.body, { childList: true });
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

    function isVisibleElement(element) {
        if (!element) {
            return false;
        }

        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
    }

    function clearImageAssistRetryTimer() {
        if (imageAssistRetryTimer) {
            clearTimeout(imageAssistRetryTimer);
            imageAssistRetryTimer = null;
        }
    }

    function clearImageAssistObserver() {
        if (imageAssistObserver) {
            imageAssistObserver.disconnect();
            imageAssistObserver = null;
        }
    }

    function clearImageAssistExpireTimer() {
        if (imageAssistExpireTimer) {
            clearTimeout(imageAssistExpireTimer);
            imageAssistExpireTimer = null;
        }
    }

    function clearImageAssistSession() {
        clearImageAssistRetryTimer();
        clearImageAssistObserver();
        clearImageAssistExpireTimer();
        imageAssistSession = null;
    }

    function finishImageAssistSession(text) {
        clearImageAssistSession();
        setImageStatus(text);
    }

    function getImageAssistClickable(target) {
        if (!(target instanceof Element)) {
            return null;
        }

        return target.closest(imageAssistClickableSelector);
    }

    function getElementLabelText(element) {
        if (element instanceof HTMLInputElement) {
            return normalizeToastText([
                element.value,
                element.getAttribute('aria-label'),
                element.title,
            ].filter(Boolean).join(' '));
        }

        return normalizeToastText([
            element.textContent,
            element.getAttribute('aria-label'),
            element.title,
        ].filter(Boolean).join(' '));
    }

    function isImageAssistButton(element) {
        return !!element && /生成图片/.test(getElementLabelText(element));
    }

    function getImageAssistMessageElement(button) {
        return button.closest('#chat .mes[mesid], .mes[mesid]');
    }

    function countImageAssistMedia(messageElement) {
        return messageElement?.querySelectorAll(imageAssistMediaSelector).length ?? 0;
    }

    function hasImageAssistSucceeded(session) {
        return !!session?.messageElement?.isConnected
            && countImageAssistMedia(session.messageElement) > session.initialMediaCount;
    }

    function finishImageAssistIfSucceeded() {
        const session = imageAssistSession;
        if (!hasImageAssistSucceeded(session)) {
            return false;
        }

        const retryText = session.retries > 0 ? `期间帮点 ${session.retries} 次` : '没有触发帮点';
        finishImageAssistSession(`已检测到出图，${retryText}`);
        return true;
    }

    function armImageAssistObserver(session) {
        clearImageAssistObserver();
        imageAssistObserver = new MutationObserver(() => {
            if (imageAssistSession === session) {
                finishImageAssistIfSucceeded();
            }
        });
        imageAssistObserver.observe(session.messageElement, { childList: true, subtree: true });
    }

    function armImageAssistExpireTimer(session) {
        clearImageAssistExpireTimer();
        imageAssistExpireTimer = setTimeout(() => {
            if (imageAssistSession === session) {
                finishImageAssistSession('等待超过 10 分钟，已停止协助');
            }
        }, imageAssistSessionTtl);
    }

    function startImageAssistSession(button, messageElement) {
        const settings = getSettings();
        clearImageAssistSession();

        imageAssistSession = {
            button,
            messageElement,
            initialMediaCount: countImageAssistMedia(messageElement),
            retries: 0,
            startedAt: Date.now(),
            lastErrorText: '',
        };

        armImageAssistObserver(imageAssistSession);
        armImageAssistExpireTimer(imageAssistSession);
        setImageStatus(`已记录手动点击，等待结果（最多帮点 ${settings.imageAssistMaxRetries} 次）`);
        finishImageAssistIfSucceeded();
    }

    function handleImageAssistUserClick(event) {
        const settings = getSettings();
        if (!settings.imageAssistEnabled || !event.isTrusted) {
            return;
        }

        const button = getImageAssistClickable(event.target);
        if (!isImageAssistButton(button)) {
            return;
        }

        if (settings.imageAssistMaxRetries <= 0) {
            setImageStatus('已点击生成图片，但最多帮点次数为 0，不会自动补点');
            return;
        }

        const messageElement = getImageAssistMessageElement(button);
        if (!messageElement) {
            setImageStatus('已点击生成图片，但未找到对应楼层，未接管');
            return;
        }

        startImageAssistSession(button, messageElement);
    }

    function resolveImageAssistButton(session) {
        if (isImageAssistButton(session.button) && session.button.isConnected) {
            return session.button;
        }

        if (!session.messageElement?.isConnected) {
            return null;
        }

        const replacement = Array.from(session.messageElement.querySelectorAll(imageAssistClickableSelector))
            .find(isImageAssistButton);
        if (replacement) {
            session.button = replacement;
        }

        return replacement ?? null;
    }

    function isImageAssistButtonClickable(button) {
        if (!(button instanceof HTMLElement) || !button.isConnected || !isVisibleElement(button)) {
            return false;
        }

        if ((button instanceof HTMLButtonElement || button instanceof HTMLInputElement) && button.disabled) {
            return false;
        }

        const style = getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        return button.getAttribute('aria-disabled') !== 'true'
            && !button.classList.contains('disabled')
            && !button.classList.contains('disabledButton')
            && style.pointerEvents !== 'none'
            && rect.width > 0
            && rect.height > 0;
    }

    function scheduleImageAssistRetryCheck(delay = imageAssistRetryCheckInterval) {
        clearImageAssistRetryTimer();
        imageAssistRetryTimer = setTimeout(() => {
            imageAssistRetryTimer = null;
            runImageAssistRetryCheck();
        }, delay);
    }

    function runImageAssistRetryCheck() {
        const settings = getSettings();
        const session = imageAssistSession;
        if (!session) {
            return;
        }

        if (!settings.imageAssistEnabled) {
            finishImageAssistSession('协助生图已关闭，停止补点');
            return;
        }

        if (settings.imageAssistMaxRetries <= 0) {
            finishImageAssistSession('最多帮点次数为 0，停止补点');
            return;
        }

        if (Date.now() - session.startedAt > imageAssistSessionTtl) {
            finishImageAssistSession('等待超过 10 分钟，已停止协助');
            return;
        }

        if (finishImageAssistIfSucceeded()) {
            return;
        }

        if (!session.messageElement?.isConnected) {
            finishImageAssistSession('对应楼层已不可用，停止协助');
            return;
        }

        if (session.retries >= settings.imageAssistMaxRetries) {
            finishImageAssistSession(`已达到帮点上限（${settings.imageAssistMaxRetries} 次），停止协助`);
            return;
        }

        const button = resolveImageAssistButton(session);
        if (!isImageAssistButtonClickable(button)) {
            setImageStatus(`等待生成图片按钮恢复可点（${session.retries}/${settings.imageAssistMaxRetries}，最近报错：${shortenStatusText(session.lastErrorText) || '无'}）`);
            scheduleImageAssistRetryCheck();
            return;
        }

        session.retries += 1;
        setImageStatus(`正在帮点生成图片 ${session.retries}/${settings.imageAssistMaxRetries}`);
        console.info(`[${extensionKey}] Image generation toast failure; clicking image button ${session.retries}/${settings.imageAssistMaxRetries}.`);
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }

    function handleImageAssistToast(kind, text) {
        const settings = getSettings();
        const session = imageAssistSession;
        if (!settings.imageAssistEnabled || !session) {
            return;
        }

        if (finishImageAssistIfSucceeded()) {
            return;
        }

        session.lastErrorText = `${kind}：${text}`;
        if (session.retries >= settings.imageAssistMaxRetries) {
            finishImageAssistSession(`收到报错“${shortenStatusText(session.lastErrorText)}”，已达到帮点上限（${settings.imageAssistMaxRetries} 次）`);
            return;
        }

        setImageStatus(`收到报错“${shortenStatusText(session.lastErrorText)}”，等待按钮可点后帮点 ${session.retries + 1}/${settings.imageAssistMaxRetries}`);
        scheduleImageAssistRetryCheck();
    }

    function isInsideMessageBodyOrControls(element) {
        const unsafeSelector = '.mes_text, .mes_reasoning, .mes_buttons, .extraMesButtons, .mes_edit_buttons, .mesAvatarWrapper, .del_checkbox, .for_checkbox';
        return !!element.closest(unsafeSelector) || !!element.querySelector(unsafeSelector);
    }

    function getElementDepth(element, root) {
        let depth = 0;
        let current = element;

        while (current && current !== root) {
            depth += 1;
            current = current.parentElement;
        }

        return depth;
    }

    function getAssistantMetadataElement(messageElement) {
        const candidates = Array.from(messageElement.querySelectorAll('span, small, div, p'))
            .filter(element => !element.classList.contains(retryCounterClass))
            .filter(element => !isInsideMessageBodyOrControls(element))
            .filter(isVisibleElement)
            .map(element => ({
                element,
                text: element.textContent.replace(/\s+/g, ' ').trim(),
            }))
            .filter(candidate => candidate.text.length <= 100 && metadataTextPattern.test(candidate.text));

        candidates.sort((left, right) => {
            const lengthDifference = left.text.length - right.text.length;
            if (lengthDifference !== 0) {
                return lengthDifference;
            }

            return getElementDepth(right.element, messageElement) - getElementDepth(left.element, messageElement);
        });

        return candidates[0]?.element ?? null;
    }

    function getAvatarMetadataTarget(messageElement) {
        const avatarContainer = messageElement.querySelector('.mesAvatarWrapper');
        const tokenCounter = avatarContainer?.querySelector('.tokenCounterDisplay');
        const timer = avatarContainer?.querySelector('.mes_timer');

        if (!isVisibleElement(avatarContainer) || !isVisibleElement(tokenCounter) || !isVisibleElement(timer)) {
            return null;
        }

        return {
            container: avatarContainer,
            anchor: timer,
            locationClass: 'empty-reply-regenerator-retry-counter--avatar-meta',
            getText: count => ` | 重试 ${count} 次`,
        };
    }

    function getRetryCounterTarget(messageElement) {
        const avatarMetadataTarget = getAvatarMetadataTarget(messageElement);
        if (avatarMetadataTarget) {
            return avatarMetadataTarget;
        }

        const assistantMetadataElement = getAssistantMetadataElement(messageElement);
        if (assistantMetadataElement) {
            return {
                container: assistantMetadataElement,
                anchor: assistantMetadataElement.lastElementChild,
                locationClass: 'empty-reply-regenerator-retry-counter--assistant-meta',
                getText: count => ` | 重试 ${count} 次`,
            };
        }

        const headerContainer = messageElement.querySelector('.mes_block .ch_name .alignItemsBaseline')
            || messageElement.querySelector('.mes_block .ch_name');

        if (isVisibleElement(headerContainer)) {
            return {
                container: headerContainer,
                anchor: headerContainer.querySelector('.timestamp')
                    || headerContainer.querySelector('.name_text')
                    || headerContainer.lastElementChild,
                locationClass: 'empty-reply-regenerator-retry-counter--header',
                getText: count => `空回重试 ${count} 次`,
            };
        }

        const avatarContainer = messageElement.querySelector('.mesAvatarWrapper');
        if (isVisibleElement(avatarContainer)) {
            return {
                container: avatarContainer,
                anchor: avatarContainer.querySelector('.tokenCounterDisplay')
                    || avatarContainer.querySelector('.mes_timer')
                    || avatarContainer.lastElementChild,
                locationClass: 'empty-reply-regenerator-retry-counter--avatar',
                getText: count => `空回重试 ${count} 次`,
            };
        }

        return null;
    }

    function renderRetryCounter(messageIndex) {
        const message = chat[messageIndex];
        const messageElement = document.querySelector(`#chat .mes[mesid="${messageIndex}"]`);
        const target = messageElement ? getRetryCounterTarget(messageElement) : null;

        if (!messageElement || !target) {
            return;
        }

        let counter = messageElement.querySelector(`.${retryCounterClass}`);
        const count = getStoredRetryCount(message);

        if (!count) {
            messageElement.querySelectorAll(`.${retryCounterClass}`).forEach(element => element.remove());
            return;
        }

        if (counter?.parentElement !== target.container) {
            counter?.remove();
            counter = null;
        }

        if (!counter) {
            counter = document.createElement('span');

            if (target.anchor) {
                target.anchor.insertAdjacentElement('afterend', counter);
            } else {
                target.container.append(counter);
            }
        }

        counter.className = `${retryCounterClass} ${target.locationClass}`;
        counter.textContent = target.getText(count);
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

        const finishedRetryCount = retryCount;
        if (!message.extra || typeof message.extra !== 'object') {
            message.extra = {};
        }

        message.extra[retryCountExtraKey] = finishedRetryCount;
        renderRetryCounter(messageIndex);
        await saveChatConditional();
        resetRetrySession();
        setStatus('');
        setLastStatus(`${formatMessageIndex(messageIndex)}重试 ${finishedRetryCount} 次后成功`);
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
        if (!settings.enabled) {
            setLastStatus('插件已关闭');
            return;
        }

        if (generationStopped) {
            setLastStatus('本轮已手动停止，未重试');
            return;
        }

        if (isGenerationStillActive()) {
            setLastStatus('生成仍在进行，等待结束后检查');
            return;
        }

        if (!shouldCheckGenerationType()) {
            setLastStatus('本次生成类型不处理，未重试');
            return;
        }

        const messageIndex = chat.length - 1;
        const lastMessage = chat[messageIndex];
        const emptyCandidate = getEmptyReplyCandidate(messageIndex, lastMessage);

        if (!emptyCandidate) {
            const recorded = await recordRetryCountOnFinalReply(messageIndex, lastMessage);
            if (!recorded) {
                if (isCompletedAiReply(lastMessage)) {
                    setLastStatus(`${formatMessageIndex(messageIndex)}正文非空（${getReplyLength(lastMessage)} 字），未重试`);
                } else if (lastMessage?.is_user) {
                    setLastStatus('最后一楼仍是用户消息，但本轮未确认发出请求，未重试');
                } else {
                    setLastStatus('最后一楼不是已完成 AI 回复，未重试');
                }
            }
            return;
        }

        const messageKey = emptyCandidate.key;
        if (messageKey === lastHandledEmptyKey) {
            setLastStatus(`${emptyCandidate.label}，已处理过，等待下一轮生成`);
            return;
        }

        if (retryCount >= settings.maxRetries) {
            lastHandledEmptyKey = messageKey;
            setStatus(`检测到空回，但已达到重试上限（${settings.maxRetries}）`);
            setLastStatus(`${emptyCandidate.label}，但已达到重试上限（${settings.maxRetries}）`);
            return;
        }

        const resumeDelay = getRetryResumeDelay(settings);
        if (resumeDelay > 0) {
            setStatus(`检测到空回；已达到每分钟自动重试上限，约 ${formatDelay(resumeDelay)} 后继续`);
            setLastStatus(`${emptyCandidate.label}；已达到每分钟自动重试上限，约 ${formatDelay(resumeDelay)} 后继续`);
            scheduleRpmResume(resumeDelay);
            return;
        }

        retryCount += 1;
        lastHandledEmptyKey = messageKey;
        setStatus(`检测到空回，正在重新生成 ${retryCount}/${settings.maxRetries}`);
        setLastStatus(`${emptyCandidate.label}，正在重新生成 ${retryCount}/${settings.maxRetries}`);
        triggerRegenerate(reason);
    }

    function triggerRegenerate(reason) {
        const regenerateButton = document.getElementById('option_regenerate');
        if (!regenerateButton) {
            setStatus('未找到重新生成按钮');
            setLastStatus('检测到空回，但未找到重新生成按钮');
            return;
        }

        clearToastRetryChecks();
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
        generationStartChatLength = 0;
        generationStartLastMessageKey = '';
        generationRequestSubmitted = false;
        generationRequestId = 0;

        if (pendingAutoRetryTimer) {
            clearTimeout(pendingAutoRetryTimer);
            pendingAutoRetryTimer = null;
        }

        if (rpmResumeTimer) {
            clearTimeout(rpmResumeTimer);
            rpmResumeTimer = null;
        }

        clearToastRetryChecks();
    }

    function onGenerationStarted(type) {
        activeGenerationType = type || 'normal';
        generationStopped = false;
        generationRequestSubmitted = false;
        generationStartChatLength = 0;
        generationStartLastMessageKey = '';

        if (pendingAutoRetry) {
            pendingAutoRetry = false;
            if (pendingAutoRetryTimer) {
                clearTimeout(pendingAutoRetryTimer);
                pendingAutoRetryTimer = null;
            }
            return;
        }

        retryCount = 0;
        generationRequestId = 0;
        lastHandledEmptyKey = '';
        setStatus('');
        setLastStatus('生成开始，等待结束后检查');
    }

    function onGenerateAfterData(_data, dryRun) {
        if (dryRun || !shouldCheckGenerationType()) {
            return;
        }

        markGenerationCheckpointFromCurrentChat();
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
                        <b>PVP高手</b>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    </div>
                    <div class="inline-drawer-content">
                        <div class="empty-reply-regenerator-content">
                            <label class="checkbox_label empty-reply-regenerator-enabled" for="${enabledInputId}">
                                <input id="${enabledInputId}" type="checkbox">
                                <span>检测到空回时自动重新生成（生成结束后检查正文为空或无新回复）</span>
                            </label>
                            <div class="empty-reply-regenerator-row">
                                <label for="${maxRetriesInputId}">每轮最大重试次数</label>
                                <input id="${maxRetriesInputId}" class="text_pole empty-reply-regenerator-number" type="number" min="0" max="200" step="1">
                            </div>
                            <div class="empty-reply-regenerator-row">
                                <label for="${rpmLimitInputId}">每分钟最大自动重试次数（RPM：每分钟请求数，0 为不限）</label>
                                <input id="${rpmLimitInputId}" class="text_pole empty-reply-regenerator-number" type="number" min="0" max="120" step="1">
                            </div>
                            <label class="checkbox_label empty-reply-regenerator-enabled" for="${imageAssistEnabledInputId}">
                                <input id="${imageAssistEnabledInputId}" type="checkbox">
                                <span>协助生图重试（只在你手动点击生成图片后帮忙补点）</span>
                            </label>
                            <div class="empty-reply-regenerator-row">
                                <label for="${imageAssistMaxRetriesInputId}">每次生图最多帮点次数</label>
                                <input id="${imageAssistMaxRetriesInputId}" class="text_pole empty-reply-regenerator-number" type="number" min="0" max="20" step="1">
                            </div>
                            <div id="${statusId}" class="empty-reply-regenerator-status"></div>
                            <div id="${lastStatusId}" class="empty-reply-regenerator-last-status"></div>
                            <div id="${imageStatusId}" class="empty-reply-regenerator-image-status"></div>
                            <div id="${toastLogId}" class="empty-reply-regenerator-toast-log"></div>
                        </div>
                    </div>
                </div>
            </div>
        `);

        const enabledInput = document.getElementById(enabledInputId);
        const maxRetriesInput = document.getElementById(maxRetriesInputId);
        const rpmLimitInput = document.getElementById(rpmLimitInputId);
        const imageAssistEnabledInput = document.getElementById(imageAssistEnabledInputId);
        const imageAssistMaxRetriesInput = document.getElementById(imageAssistMaxRetriesInputId);
        enabledInput.checked = settings.enabled;
        maxRetriesInput.value = String(settings.maxRetries);
        rpmLimitInput.value = String(settings.rpmLimit);
        imageAssistEnabledInput.checked = settings.imageAssistEnabled;
        imageAssistMaxRetriesInput.value = String(settings.imageAssistMaxRetries);
        setStatus('');
        setLastStatus('');
        setImageStatus('');
        renderToastLog();

        enabledInput.addEventListener('change', () => {
            const currentSettings = getSettings();
            currentSettings.enabled = enabledInput.checked;
            setStatus('');
            setLastStatus(currentSettings.enabled ? '插件已开启' : '插件已关闭');
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

        imageAssistEnabledInput.addEventListener('change', () => {
            const currentSettings = getSettings();
            currentSettings.imageAssistEnabled = imageAssistEnabledInput.checked;
            clearImageAssistSession();
            setImageStatus(currentSettings.imageAssistEnabled ? '已开启，等待你手动点击生成图片' : '已关闭');
            saveSettings();
        });

        imageAssistMaxRetriesInput.addEventListener('change', () => {
            const currentSettings = getSettings();
            currentSettings.imageAssistMaxRetries = normalizeImageAssistMaxRetries(imageAssistMaxRetriesInput.value);
            imageAssistMaxRetriesInput.value = String(currentSettings.imageAssistMaxRetries);
            if (imageAssistSession && imageAssistSession.retries >= currentSettings.imageAssistMaxRetries) {
                finishImageAssistSession(`已达到新的帮点上限（${currentSettings.imageAssistMaxRetries} 次），停止协助`);
            }
            saveSettings();
        });
    }

    function init() {
        getSettings();
        injectSettingsPanel();
        initToastObserver();
        renderAllRetryCounters();
        document.addEventListener('click', handleImageAssistUserClick, true);

        eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
        eventSource.on(event_types.GENERATE_AFTER_DATA, onGenerateAfterData);
        eventSource.on(event_types.GENERATION_STOPPED, () => {
            generationStopped = true;
            pendingAutoRetry = false;
            setLastStatus('本轮已手动停止，未重试');
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
            clearImageAssistSession();
            setImageStatus('');
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
