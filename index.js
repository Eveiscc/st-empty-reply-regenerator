import {
    chat,
    eventSource,
    event_types,
    is_send_press,
    saveSettingsDebounced,
} from '/script.js';
import { extension_settings } from '/scripts/extensions.js';
import { is_group_generating } from '/scripts/group-chats.js';

(function () {
    'use strict';

    const extensionKey = 'empty_reply_regenerator';
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
    const diagnosticLogId = `${extensionKey}_diagnostic_log`;
    const maxToastLogEntries = 3;
    const maxDiagnosticLogEntries = 8;
    const toastRetryCheckDelays = Object.freeze([700, 1800]);
    const foregroundRetryCheckDelays = Object.freeze([300, 1500, 4000]);
    const noNewReplyRetryMinDelay = 1500;
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
    let generationStartLastMessageWasUser = false;
    let generationStartType = null;
    let generationStartedAt = 0;
    let generationCheckpointAt = 0;
    let generationRequestSubmitted = false;
    let generationRequestId = 0;
    let toastLogEntries = [];
    let diagnosticLogEntries = [];
    let toastContainerObserver = null;
    let toastBodyObserver = null;
    let observedToastContainer = null;
    let toastRetryCheckTimers = [];
    let foregroundRetryCheckTimers = [];
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
            const nextText = text || '';
            if (status.textContent !== nextText) {
                status.textContent = nextText;
            }
        }
    }

    function setLastStatus(text) {
        const status = document.getElementById(lastStatusId);
        if (status) {
            const nextText = text ? `最近检测：${text}` : '';
            if (status.textContent !== nextText) {
                status.textContent = nextText;
            }
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

    function renderDiagnosticLog() {
        const log = document.getElementById(diagnosticLogId);
        if (!log) {
            return;
        }

        log.textContent = diagnosticLogEntries.length > 0
            ? `诊断记录：\n${diagnosticLogEntries.map(entry => `${entry.time} ${entry.text}`).join('\n')}`
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

    function formatDiagnosticDetails(details) {
        return Object.entries(details)
            .filter(([, value]) => value !== undefined && value !== null && value !== '')
            .map(([key, value]) => `${key}=${String(value)}`)
            .join('；');
    }

    function recordDiagnostic(action, details = {}) {
        const detailText = formatDiagnosticDetails(details);
        diagnosticLogEntries.unshift({
            time: formatLogTime(),
            text: detailText ? `${action}：${detailText}` : action,
        });
        diagnosticLogEntries = diagnosticLogEntries.slice(0, maxDiagnosticLogEntries);
        renderDiagnosticLog();
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
        // 空回的主判断只看原始正文；DOM 只作为“已有可见正文时禁止重试”的额外保护。
        const text = String(message?.mes ?? '').replace(blankCharacters, '').trim();
        return text === '...' ? '' : text;
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

    function isAiReply(message) {
        return !!message && !message.is_user && !message.is_system;
    }

    function getMessageRole(message) {
        if (!message) {
            return 'none';
        }

        if (message.is_user) {
            return 'user';
        }

        if (message.is_system) {
            return 'system';
        }

        return 'ai';
    }

    function getTrackedGenerationFirstMessageIndex() {
        if (!generationRequestSubmitted || generationStartChatLength <= 0) {
            return -1;
        }

        if (generationStartType === 'regenerate') {
            return Math.max(0, generationStartChatLength - 1);
        }

        return generationStartChatLength;
    }

    function isCurrentGenerationMessage(messageIndex) {
        const firstMessageIndex = getTrackedGenerationFirstMessageIndex();
        return Number.isInteger(messageIndex)
            && firstMessageIndex >= 0
            && messageIndex >= firstMessageIndex;
    }

    function isEligibleEmptyReply(messageIndex, message) {
        return isCurrentGenerationMessage(messageIndex)
            && isAiReply(message)
            && getReplyText(message).length === 0;
    }

    function getCurrentGenerationAiMessages() {
        const firstMessageIndex = getTrackedGenerationFirstMessageIndex();
        if (firstMessageIndex < 0) {
            return [];
        }

        return chat
            .slice(firstMessageIndex)
            .filter(isAiReply);
    }

    function getReplyTextFromMessageElement(messageIndex) {
        const messageElement = document.querySelector(`#chat .mes[mesid="${messageIndex}"]`);
        const text = String(messageElement?.querySelector('.mes_text')?.textContent ?? '')
            .replace(blankCharacters, '')
            .trim();
        return text === '...' ? '' : text;
    }

    function isLastAiEmptyReply() {
        const messageIndex = chat.length - 1;
        const lastMessage = chat[messageIndex];
        return isAiReply(lastMessage)
            && getReplyText(lastMessage).length === 0
            && getReplyTextFromMessageElement(messageIndex).length === 0;
    }

    function getExistingReplyTextGuardReason() {
        const currentGenerationMessage = getCurrentGenerationAiMessages()
            .find(message => getReplyText(message).length > 0);
        if (currentGenerationMessage) {
            return `本轮 AI 楼已有正文 ${getReplyText(currentGenerationMessage).length} 字`;
        }

        const lastIndex = chat.length - 1;
        const lastMessage = chat[lastIndex];
        const lastReplyLength = getReplyText(lastMessage).length;
        if (isAiReply(lastMessage) && lastReplyLength > 0) {
            return `最后 AI 楼原始正文 ${lastReplyLength} 字`;
        }

        const lastVisibleReplyLength = getReplyTextFromMessageElement(lastIndex).length;
        if (isAiReply(lastMessage) && lastVisibleReplyLength > 0) {
            return `最后 AI 楼页面正文 ${lastVisibleReplyLength} 字`;
        }

        return '';
    }

    function hasExistingReplyTextGuard() {
        return getExistingReplyTextGuardReason() !== '';
    }

    function getDiagnosticSnapshot(extra = {}) {
        const lastIndex = chat.length - 1;
        const lastMessage = chat[lastIndex];
        const currentAiLengths = getCurrentGenerationAiMessages()
            .map(message => getReplyText(message).length)
            .join(',');

        return {
            ...extra,
            req: generationRequestSubmitted ? generationRequestId : `${generationRequestId}/idle`,
            type: activeGenerationType ?? 'none',
            startType: generationStartType ?? 'none',
            retry: retryCount,
            chat: `${chat.length}/${generationStartChatLength}`,
            last: `${lastIndex}:${getMessageRole(lastMessage)}:${getReplyText(lastMessage).length}`,
            lastDom: getReplyTextFromMessageElement(lastIndex).length,
            currentAi: currentAiLengths || 'none',
        };
    }

    function isStaleGenerationCheck(expectedGenerationRequestId) {
        if (!Number.isInteger(expectedGenerationRequestId) || expectedGenerationRequestId <= 0) {
            return generationRequestSubmitted;
        }

        return Number.isInteger(expectedGenerationRequestId)
            && expectedGenerationRequestId !== generationRequestId;
    }

    function isNoGeneratedReplyBaseCandidate() {
        if (!generationRequestSubmitted || chat.length <= 0 || generationStartChatLength <= 0) {
            return false;
        }

        if (chat.length !== generationStartChatLength || getCurrentLastMessageKey() !== generationStartLastMessageKey) {
            return false;
        }

        const lastMessage = chat[chat.length - 1];
        return (generationStartLastMessageWasUser && lastMessage?.is_user)
            || (generationStartType === 'regenerate' && isLastAiEmptyReply());
    }

    function getNoGeneratedReplyRetryDelay() {
        if (!isNoGeneratedReplyBaseCandidate()) {
            return null;
        }

        return Math.max(0, noNewReplyRetryMinDelay - (Date.now() - generationCheckpointAt));
    }

    function hasNoGeneratedReplyChange() {
        const retryDelay = getNoGeneratedReplyRetryDelay();
        return retryDelay !== null && retryDelay === 0;
    }

    function getEmptyReplyCandidate(messageIndex, message) {
        if (hasExistingReplyTextGuard()) {
            return null;
        }

        if (isEligibleEmptyReply(messageIndex, message)) {
            return {
                key: getMessageKey(messageIndex, message),
                label: `${formatMessageIndex(messageIndex)}正文为空`,
            };
        }

        if (hasNoGeneratedReplyChange()) {
            return {
                key: `no-ai-reply|${generationRequestId}|${generationStartLastMessageKey}`,
                label: '本轮没有创建新的 AI 回复',
            };
        }

        return null;
    }

    function shouldCheckGenerationType() {
        return activeGenerationType === null || eligibleGenerationTypes.has(activeGenerationType);
    }

    function hasTrackedTextGeneration() {
        return generationRequestSubmitted;
    }

    function clearGenerationCheckpoint() {
        activeGenerationType = null;
        generationStartChatLength = 0;
        generationStartLastMessageKey = '';
        generationStartLastMessageWasUser = false;
        generationStartType = null;
        generationStartedAt = 0;
        generationCheckpointAt = 0;
        generationRequestSubmitted = false;
        clearToastRetryChecks();
    }

    function markGenerationCheckpointFromCurrentChat() {
        const lastMessage = chat[chat.length - 1];
        const isNewTrackedRequest = !generationRequestSubmitted;

        generationRequestSubmitted = true;
        if (isNewTrackedRequest) {
            generationRequestId += 1;
        }
        generationStartChatLength = chat.length;
        generationStartLastMessageKey = getCurrentLastMessageKey();
        generationStartLastMessageWasUser = !!lastMessage?.is_user;
        generationStartType = activeGenerationType;
        generationCheckpointAt = Date.now();
    }

    function getGenerationCheckRequestId() {
        return generationRequestSubmitted ? generationRequestId : 0;
    }

    function markToastFailureCheckpointIfNeeded() {
        if (generationRequestSubmitted || generationStopped || activeGenerationType === null || !shouldCheckGenerationType()) {
            return;
        }

        if (!generationStartedAt || Date.now() - generationStartedAt > 120000) {
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

    function clearForegroundRetryChecks() {
        foregroundRetryCheckTimers.forEach(timer => clearTimeout(timer));
        foregroundRetryCheckTimers = [];
    }

    function scheduleToastRetryChecks() {
        if (!getSettings().enabled || generationStopped || !generationRequestSubmitted) {
            return;
        }

        clearToastRetryChecks();
        const expectedGenerationRequestId = getGenerationCheckRequestId();
        toastRetryCheckTimers = toastRetryCheckDelays.map(delay => setTimeout(() => {
            scheduleEmptyReplyCheck('toast_error', expectedGenerationRequestId);
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
        scheduleImmediateEmptyReplyCheck('toast_error', getGenerationCheckRequestId());
        scheduleToastRetryChecks();
    }

    function recordExistingToastElements(container) {
        Array.from(container.children).forEach(recordToastElement);
    }

    function observeToastContainer(container) {
        if (!(container instanceof HTMLElement)) {
            return;
        }

        recordExistingToastElements(container);
        if (observedToastContainer === container) {
            return;
        }

        if (toastContainerObserver) {
            toastContainerObserver.disconnect();
        }

        observedToastContainer = container;
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

    function shouldRunForegroundEmptyReplyCheck() {
        return getSettings().enabled
            && !generationStopped
            && generationRequestSubmitted
            && shouldCheckGenerationType();
    }

    function scheduleForegroundRecoveryChecks(reason) {
        if (document.visibilityState === 'hidden') {
            return;
        }

        initToastObserver();

        if (shouldRunForegroundEmptyReplyCheck()) {
            const expectedGenerationRequestId = getGenerationCheckRequestId();
            clearForegroundRetryChecks();
            foregroundRetryCheckTimers = foregroundRetryCheckDelays.map(delay => setTimeout(() => {
                scheduleEmptyReplyCheck(reason, expectedGenerationRequestId);
            }, delay));
        }

        const imageSession = imageAssistSession;
        if (imageSession && getSettings().imageAssistEnabled && !finishImageAssistIfSucceeded() && imageAssistSession === imageSession && imageSession.lastErrorText) {
            scheduleImageAssistRetryCheck(300);
        }
    }

    function handleForegroundResume() {
        scheduleForegroundRecoveryChecks('foreground_resume');
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

    function scheduleRpmResume(delay, expectedGenerationRequestId) {
        if (rpmResumeTimer) {
            clearTimeout(rpmResumeTimer);
        }

        rpmResumeTimer = setTimeout(() => {
            rpmResumeTimer = null;
            scheduleEmptyReplyCheck('rpm_limit_released', expectedGenerationRequestId);
        }, delay + 100);
    }

    function formatDelay(milliseconds) {
        return `${Math.max(1, Math.ceil(milliseconds / 1000))} 秒`;
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

    async function recordRetryCountOnFinalReply(messageIndex, message) {
        if (retryCount <= 0 || !isCompletedAiReply(message) || getReplyText(message).length === 0) {
            return false;
        }

        const finishedRetryCount = retryCount;
        resetRetrySession();
        setStatus('');
        setLastStatus(`${formatMessageIndex(messageIndex)}重试 ${finishedRetryCount} 次后成功`);
        return true;
    }

    function scheduleEmptyReplyCheck(reason, expectedGenerationRequestId = getGenerationCheckRequestId()) {
        if (scheduledCheck) {
            clearTimeout(scheduledCheck);
        }

        scheduledCheck = setTimeout(() => {
            scheduledCheck = null;
            void checkForEmptyReply(reason, expectedGenerationRequestId);
        }, 300);
    }

    function scheduleDelayedEmptyReplyCheck(reason, delay, expectedGenerationRequestId = getGenerationCheckRequestId()) {
        if (scheduledCheck) {
            clearTimeout(scheduledCheck);
        }

        scheduledCheck = setTimeout(() => {
            scheduledCheck = null;
            void checkForEmptyReply(reason, expectedGenerationRequestId);
        }, Math.max(0, delay));
    }

    function scheduleImmediateEmptyReplyCheck(reason, expectedGenerationRequestId = getGenerationCheckRequestId()) {
        Promise.resolve().then(() => checkForEmptyReply(reason, expectedGenerationRequestId));
    }

    async function checkForEmptyReply(reason, expectedGenerationRequestId = getGenerationCheckRequestId()) {
        const settings = getSettings();
        if (!settings.enabled) {
            setLastStatus('插件已关闭');
            return;
        }

        if (isStaleGenerationCheck(expectedGenerationRequestId)) {
            recordDiagnostic('跳过旧检查', getDiagnosticSnapshot({ reason, expected: expectedGenerationRequestId, actual: generationRequestId }));
            return;
        }

        if (generationStopped) {
            setLastStatus('本轮已手动停止，未重试');
            return;
        }

        if (isGenerationStillActive()) {
            return;
        }

        if (!shouldCheckGenerationType()) {
            setLastStatus('本次生成类型不处理，未重试');
            clearGenerationCheckpoint();
            return;
        }

        if (!hasTrackedTextGeneration()) {
            return;
        }

        const guardReason = getExistingReplyTextGuardReason();
        if (guardReason) {
            const messageIndex = chat.length - 1;
            const lastMessage = chat[messageIndex];
            const recorded = await recordRetryCountOnFinalReply(messageIndex, lastMessage);
            if (!recorded) {
                setLastStatus(`检测到已有正文（${guardReason}），未重试`);
                clearGenerationCheckpoint();
            }
            return;
        }

        const noGeneratedReplyRetryDelay = getNoGeneratedReplyRetryDelay();
        if (noGeneratedReplyRetryDelay > 0) {
            setLastStatus(`本轮暂未产生新 AI 回复，等待 ${formatDelay(noGeneratedReplyRetryDelay)} 后确认是否需要重试`);
            recordDiagnostic('延后检查', getDiagnosticSnapshot({ reason, delay: formatDelay(noGeneratedReplyRetryDelay) }));
            scheduleDelayedEmptyReplyCheck('no_ai_reply_confirm', noGeneratedReplyRetryDelay + 50, expectedGenerationRequestId);
            return;
        }

        const messageIndex = chat.length - 1;
        const lastMessage = chat[messageIndex];
        const emptyCandidate = getEmptyReplyCandidate(messageIndex, lastMessage);

        if (!emptyCandidate) {
            const recorded = await recordRetryCountOnFinalReply(messageIndex, lastMessage);
            if (!recorded) {
                if (isCompletedAiReply(lastMessage) && getReplyLength(lastMessage) > 0) {
                    setLastStatus(`${formatMessageIndex(messageIndex)}正文非空（${getReplyLength(lastMessage)} 字），未重试`);
                    clearGenerationCheckpoint();
                } else if (isCompletedAiReply(lastMessage)) {
                    setLastStatus(`${formatMessageIndex(messageIndex)}正文为空，但不是本轮候选，未重试`);
                    recordDiagnostic('空楼未处理', getDiagnosticSnapshot({ reason, why: '不是本轮候选' }));
                    clearGenerationCheckpoint();
                } else if (getExistingReplyTextGuardReason()) {
                    const lateGuardReason = getExistingReplyTextGuardReason();
                    setLastStatus(`本轮已有正文（${lateGuardReason}），未重试`);
                    clearGenerationCheckpoint();
                } else if (lastMessage?.is_user) {
                    setLastStatus('最后一楼仍是用户消息，未重试');
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
            recordDiagnostic('跳过重试', getDiagnosticSnapshot({ reason, why: '达到重试上限', candidate: emptyCandidate.label }));
            return;
        }

        const resumeDelay = getRetryResumeDelay(settings);
        if (resumeDelay > 0) {
            setStatus(`检测到空回；已达到每分钟自动重试上限，约 ${formatDelay(resumeDelay)} 后继续`);
            setLastStatus(`${emptyCandidate.label}；已达到每分钟自动重试上限，约 ${formatDelay(resumeDelay)} 后继续`);
            recordDiagnostic('延后重试', getDiagnosticSnapshot({ reason, why: 'RPM 限制', candidate: emptyCandidate.label, delay: formatDelay(resumeDelay) }));
            scheduleRpmResume(resumeDelay, expectedGenerationRequestId);
            return;
        }

        retryCount += 1;
        lastHandledEmptyKey = messageKey;
        setStatus(`检测到空回，正在重新生成 ${retryCount}/${settings.maxRetries}`);
        setLastStatus(`${emptyCandidate.label}，正在重新生成 ${retryCount}/${settings.maxRetries}`);
        recordDiagnostic('准备自动重试', getDiagnosticSnapshot({ reason, candidate: emptyCandidate.label }));
        triggerRegenerate(reason, expectedGenerationRequestId);
    }

    function triggerRegenerate(reason, expectedGenerationRequestId = getGenerationCheckRequestId()) {
        if (isStaleGenerationCheck(expectedGenerationRequestId)) {
            recordDiagnostic('取消旧自动重试', getDiagnosticSnapshot({ reason, expected: expectedGenerationRequestId, actual: generationRequestId }));
            return;
        }

        const guardReason = getExistingReplyTextGuardReason();
        if (guardReason) {
            setStatus('');
            setLastStatus(`触发前发现已有正文（${guardReason}），已取消自动重试`);
            recordDiagnostic('取消自动重试', getDiagnosticSnapshot({ reason, why: guardReason }));
            clearGenerationCheckpoint();
            return;
        }

        const regenerateButton = document.getElementById('option_regenerate');
        if (!regenerateButton) {
            setStatus('未找到重新生成按钮');
            setLastStatus('检测到空回，但未找到重新生成按钮');
            recordDiagnostic('重试失败', getDiagnosticSnapshot({ reason, why: '未找到重新生成按钮' }));
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
        recordDiagnostic('点击重新生成', getDiagnosticSnapshot({ reason }));
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
        generationStartLastMessageWasUser = false;
        generationStartType = null;
        generationStartedAt = 0;
        generationCheckpointAt = 0;
        generationRequestSubmitted = false;

        if (pendingAutoRetryTimer) {
            clearTimeout(pendingAutoRetryTimer);
            pendingAutoRetryTimer = null;
        }

        if (rpmResumeTimer) {
            clearTimeout(rpmResumeTimer);
            rpmResumeTimer = null;
        }

        clearToastRetryChecks();
        clearForegroundRetryChecks();
    }

    function onGenerationStarted(type, _params, dryRun) {
        if (dryRun) {
            return;
        }

        activeGenerationType = type || 'normal';
        generationStopped = false;
        generationRequestSubmitted = false;
        generationStartChatLength = 0;
        generationStartLastMessageKey = '';
        generationStartLastMessageWasUser = false;
        generationStartType = null;
        generationStartedAt = Date.now();
        generationCheckpointAt = 0;

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
        setLastStatus('');
    }

    function onGenerationAfterCommands(type, _params, dryRun) {
        if (dryRun) {
            return;
        }

        activeGenerationType = type || activeGenerationType || 'normal';
        if (!shouldCheckGenerationType()) {
            return;
        }

        markGenerationCheckpointFromCurrentChat();
    }

    function onGenerateAfterData(_data, dryRun) {
        if (dryRun || !shouldCheckGenerationType()) {
            return;
        }

        if (!generationRequestSubmitted) {
            markGenerationCheckpointFromCurrentChat();
        }
        setLastStatus('文本生成已提交，等待结束后检查');
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
                                <span>检测到空回时自动重新生成（生成结束后检查正文为空或未创建新 AI 回复）</span>
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
                            <div id="${diagnosticLogId}" class="empty-reply-regenerator-diagnostic-log"></div>
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
        renderDiagnosticLog();

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
        document.addEventListener('click', handleImageAssistUserClick, true);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                handleForegroundResume();
            }
        });
        window.addEventListener('focus', handleForegroundResume);
        window.addEventListener('pageshow', handleForegroundResume);

        eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
        if (event_types.GENERATION_AFTER_COMMANDS) {
            eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
        }
        eventSource.on(event_types.GENERATE_AFTER_DATA, onGenerateAfterData);
        eventSource.on(event_types.GENERATION_STOPPED, () => {
            generationStopped = true;
            pendingAutoRetry = false;
            setLastStatus('本轮已手动停止，未重试');
        });
        eventSource.on(event_types.GENERATION_ENDED, () => {
            scheduleEmptyReplyCheck('generation_ended', getGenerationCheckRequestId());
        });
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId, type) => {
            if (type) {
                activeGenerationType = type;
            }
            scheduleEmptyReplyCheck('character_message_rendered', getGenerationCheckRequestId());
        });
        eventSource.on(event_types.GROUP_WRAPPER_FINISHED, () => scheduleEmptyReplyCheck('group_wrapper_finished', getGenerationCheckRequestId()));
        eventSource.on(event_types.CHAT_CHANGED, () => {
            resetRetrySession();
            clearImageAssistSession();
            setImageStatus('');
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
