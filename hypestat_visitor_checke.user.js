// ==UserScript==
// @name         Hypestat Visitor Checker
// @namespace    http://tampermonkey.net/
// @version      1
// @description  Проверяет monthly unique visitors на hypestat.com
// @author       m31
// @match        https://hypestat.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_download
// @grant        GM_setClipboard
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ==================== КОНФИГУРАЦИЯ ====================
    const CONFIG = {
        DELAY_BETWEEN_REQUESTS: 200,
        DATA_EXTRACT_ATTEMPTS: 3,
        EXTRACT_INTERVAL: 50,
    };

    let currentQueue = [];
    let currentIndex = 0;
    let isRunning = false;
    let stopRequested = false;
    let results = [];
    let isWaitingForCaptcha = false;
    let pageLoadTime = 0;

    // ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================
    function getDomainFromUrl(url) {
        try {
            let cleanUrl = url.trim();
            if (!cleanUrl) return '';
            if (!cleanUrl.includes('://')) cleanUrl = 'https://' + cleanUrl;
            const urlObj = new URL(cleanUrl);
            let host = urlObj.hostname.toLowerCase();
            if (host.startsWith('www.')) host = host.slice(4);
            return host;
        } catch (e) {
            return '';
        }
    }

    function extractMonthlyVisitorsFromPage() {
        const dtElements = document.querySelectorAll('dt');
        for (const dt of dtElements) {
            if (dt.innerText.includes('Monthly Unique Visitors')) {
                const dd = dt.nextElementSibling;
                if (dd && dd.tagName === 'DD') {
                    const match = dd.innerText.trim().match(/(\d+(?:,\d+)*)/);
                    if (match) return match[1].replace(/,/g, '');
                }
            }
        }
        return '';
    }

    function isCaptchaPresent() {
        if (document.querySelector('iframe[src*="recaptcha"], iframe[src*="captcha"], .g-recaptcha')) return true;
        const bodyText = document.body.innerText.substring(0, 500).toLowerCase();
        return bodyText.includes('captcha') || bodyText.includes('проверку');
    }

    function saveState() {
        GM_setValue('hypestat_queue', currentQueue);
        GM_setValue('hypestat_index', currentIndex);
        GM_setValue('hypestat_running', isRunning);
        GM_setValue('hypestat_results', results);
    }

    function loadState() {
        currentQueue = GM_getValue('hypestat_queue', []);
        currentIndex = GM_getValue('hypestat_index', 0);
        isRunning = GM_getValue('hypestat_running', false);
        results = GM_getValue('hypestat_results', []);
        return isRunning && currentQueue.length > 0 && currentIndex < currentQueue.length;
    }

    function clearState() {
        GM_deleteValue('hypestat_queue');
        GM_deleteValue('hypestat_index');
        GM_deleteValue('hypestat_running');
    }

    function saveResult(sourceUrl, domain, visitors, error = '') {
        const existingIndex = results.findIndex(r => r.source_url === sourceUrl);
        const result = {
            timestamp: new Date().toISOString(),
            source_url: sourceUrl,
            domain: domain,
            visitors: visitors,
            error: error
        };
        if (existingIndex !== -1) results[existingIndex] = result;
        else results.push(result);
        GM_setValue('hypestat_results', results);
        updateTable();
    }

    // ==================== UI ====================
    function updateTable() {
        const tbody = document.getElementById('hypestat-table-body');
        if (!tbody) return;
        tbody.innerHTML = '';

        if (currentQueue.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 40px;">📝 Введите URL в поле выше и нажмите "Старт"</td></tr>';
            return;
        }

        for (let i = 0; i < currentQueue.length; i++) {
            const sourceUrl = currentQueue[i];
            const result = results.find(r => r.source_url === sourceUrl);
            const domain = getDomainFromUrl(sourceUrl);
            const row = tbody.insertRow();

            // URL
            const urlCell = row.insertCell(0);
            urlCell.innerHTML = `<a href="${sourceUrl}" target="_blank" style="color: var(--ahref_color); text-decoration: none;">${sourceUrl.length > 50 ? sourceUrl.substring(0, 47) + '...' : sourceUrl}</a>`;

            // Домен
            row.insertCell(1).textContent = domain;

            // Visitors
            const visitorsCell = row.insertCell(2);
            visitorsCell.textContent = result?.visitors ? Number(result.visitors).toLocaleString() : '-';
            visitorsCell.style.fontWeight = result?.visitors ? 'bold' : 'normal';
            visitorsCell.style.color = result?.visitors ? 'var(--button_search)' : 'var(--text_color_2)';

            // Ошибка
            const errorCell = row.insertCell(3);
            errorCell.textContent = result?.error || '-';
            errorCell.style.color = 'var(--message_color)';
            errorCell.style.fontSize = '11px';

        }

        const completed = results.filter(r => r.visitors).length;
        const errors = results.filter(r => r.error).length;
        const statusDiv = document.getElementById('hypestat-stats');
        if (statusDiv) {
            statusDiv.innerHTML = `📊 Готово: ${completed} | ❌ Ошибок: ${errors} | ⏳ Осталось: ${currentQueue.length - completed - errors}`;
        }
    }

    function updateCurrentDisplay() {
        const currentDiv = document.getElementById('hypestat-current');
        if (currentDiv && isRunning && currentIndex < currentQueue.length && !stopRequested) {
            const domain = getDomainFromUrl(currentQueue[currentIndex]);
            if (isWaitingForCaptcha) {
                currentDiv.innerHTML = `⚠️ Ждем решения капчи: ${domain} (${currentIndex + 1}/${currentQueue.length})`;
                currentDiv.style.color = 'var(--message_color)';
            } else {
                currentDiv.innerHTML = `🔄 Сейчас: ${domain} (${currentIndex + 1}/${currentQueue.length})`;
                currentDiv.style.color = 'var(--button_color)';
            }
        } else if (currentDiv) {
            currentDiv.innerHTML = '✅ Готов к работе';
            currentDiv.style.color = 'var(--button_search)';
        }
    }

    function addLog(message, isError = false) {
        const logDiv = document.getElementById('hypestat-log');
        if (!logDiv) return;
        const logEntry = document.createElement('div');
        logEntry.style.padding = '4px 0';
        logEntry.style.borderBottom = '1px solid var(--borders_color)';
        logEntry.style.fontSize = '11px';
        logEntry.style.fontFamily = 'monospace';
        logEntry.style.color = isError ? 'var(--message_color)' : 'var(--text_color_2)';
        logEntry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        logDiv.appendChild(logEntry);
        logDiv.scrollTop = logDiv.scrollHeight;
        while (logDiv.children.length > 100) logDiv.removeChild(logDiv.firstChild);
    }

    function copyTableToClipboard() {
        if (currentQueue.length === 0) {
            alert('Нет данных для копирования');
            return;
        }
        const headers = ['URL', 'Домен', 'Посетители', 'Ошибка'];
        let tsvContent = headers.join('\t') + '\n';
        for (let i = 0; i < currentQueue.length; i++) {
            const sourceUrl = currentQueue[i];
            const result = results.find(r => r.source_url === sourceUrl);
            const domain = getDomainFromUrl(sourceUrl);
            const visitors = result?.visitors ? Number(result.visitors).toLocaleString() : '-';
            const error = result?.error || '-';
            const time = result?.timestamp ? new Date(result.timestamp).toLocaleString() : '-';
            tsvContent += [sourceUrl, domain, visitors, error, time].join('\t') + '\n';
        }
        GM_setClipboard(tsvContent);
        addLog(`📋 Скопировано ${currentQueue.length} строк`);
        const copyBtn = document.getElementById('hypestat-copy-table');
        if (copyBtn) {
            const originalText = copyBtn.textContent;
            copyBtn.textContent = '✅ Скопировано!';
            setTimeout(() => { copyBtn.textContent = originalText; }, 2000);
        }
    }

    function showMainWindow() {
        const oldWindow = document.getElementById('hypestat-window');
        if (oldWindow) oldWindow.remove();

        const modal = document.createElement('div');
        modal.id = 'hypestat-window';
        modal.innerHTML = `
            <style>
                #hypestat-window {
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    width: 1100px;
                    height: 750px;
                    background: var(--site_background);
                    color: var(--text_color_1);
                    border-radius: 12px;
                    box-shadow: 0 20px 40px rgba(0,0,0,0.4);
                    z-index: 1000000;
                    display: flex;
                    flex-direction: column;
                    font-family: inherit;
                    overflow: hidden;
                    border: 1px solid var(--borders_color);
                }
                #hypestat-window .header {
                    background: var(--menu_background_color);
                    color: var(--text_color_1);
                    padding: 12px 16px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    cursor: move;
                    flex-shrink: 0;
                    border-bottom: 1px solid var(--borders_color);
                }
                #hypestat-window .header h3 { margin: 0; font-size: 14px; color: var(--text_color_1); }
                #hypestat-window .close-btn {
                    background: none; border: none; color: var(--text_color_2); font-size: 20px; cursor: pointer; padding: 0 8px;
                }
                #hypestat-window .close-btn:hover { color: var(--message_color); }
                #hypestat-window .input-area {
                    padding: 12px; background: var(--header_background); border-bottom: 1px solid var(--borders_color); flex-shrink: 0;
                }
                #hypestat-window textarea {
                    width: 100%; height: 80px; padding: 8px; border: 1px solid var(--borders_color);
                    border-radius: 6px; font-family: monospace; font-size: 12px; resize: vertical;
                    box-sizing: border-box; background: var(--input_background_color); color: var(--input_text_color);
                }
                #hypestat-window textarea:focus { outline: none; border-color: var(--button_color); background: var(--input_background_color_focus); }
                #hypestat-window .controls { display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
                #hypestat-window button {
                    padding: 6px 14px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500;
                }
                #hypestat-window .btn-start { background: var(--button_search); color: var(--buton_text_color_2); }
                #hypestat-window .btn-start:hover { background: var(--button_search_hover); }
                #hypestat-window .btn-stop { background: var(--message_color); color: var(--buton_text_color); }
                #hypestat-window .btn-stop:hover { opacity: 0.8; }
                #hypestat-window .btn-clear { background: var(--disabled_button_color); color: var(--buton_text_color); }
                #hypestat-window .btn-clear:hover { opacity: 0.8; }
                #hypestat-window .btn-copy { background: var(--button_color_2); color: var(--buton_text_color_2); }
                #hypestat-window .btn-copy:hover { background: var(--button_color_2_hover); }
                #hypestat-window .btn-export { background: var(--button_color); color: var(--buton_text_color); }
                #hypestat-window .btn-export:hover { background: var(--button_color_hover); }
                #hypestat-window .stats-bar {
                    padding: 6px 12px; background: var(--header_background); border-bottom: 1px solid var(--borders_color);
                    display: flex; justify-content: space-between; font-size: 11px; flex-shrink: 0;
                    color: var(--text_color_2);
                }
                #hypestat-window .table-container { flex: 1; overflow: auto; background: var(--site_background); }
                #hypestat-window table { width: 100%; border-collapse: collapse; font-size: 12px; background: var(--site_background); }
                #hypestat-window th {
                    background: var(--menu_background_color); padding: 8px 6px; text-align: left; position: sticky; top: 0;
                    border-bottom: 2px solid var(--borders_color); font-size: 11px; color: var(--text_color_1);
                }
                #hypestat-window td {
                    padding: 6px; border-bottom: 1px solid var(--borders_color); color: var(--text_color_1);
                }
                #hypestat-window tr:hover td { background: var(--lists_background_color); }
                #hypestat-window .log-area {
                    height: 100px; background: var(--footer_background); overflow-y: auto; padding: 6px 12px;
                    border-top: 1px solid var(--borders_color); flex-shrink: 0;
                }
                #hypestat-window td a { color: var(--ahref_color) !important; text-decoration: none; }
                #hypestat-window td a:hover { color: var(--ahref_color_hover) !important; text-decoration: underline; }
            </style>
            <div class="header">
                <h3>⚡ Hypestat Checker Pro</h3>
                <button class="close-btn" id="hypestat-close">✕</button>
            </div>
            <div class="input-area">
                <textarea id="hypestat-urls" placeholder="Введите URL (каждый с новой строки)"></textarea>
                <div class="controls">
                    <button id="hypestat-start" class="btn-start">▶ Старт</button>
                    <button id="hypestat-stop" class="btn-stop">⏹ Стоп</button>
                    <button id="hypestat-clear-table" class="btn-clear">🗑 Очистить всё</button>
                    <button id="hypestat-copy-table" class="btn-copy">📋 Копировать таблицу</button>
                    <button id="hypestat-export" class="btn-export">📥 CSV</button>
                </div>
            </div>
            <div class="stats-bar">
                <span id="hypestat-stats">📊 Готово: 0 | ❌ Ошибок: 0</span>
                <span id="hypestat-current">✅ Готов к работе</span>
            </div>
            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>URL</th>
                            <th>Домен</th>
                            <th>Visitors</th>
                            <th>Ошибка</th>
                        </tr>
                    </thead>
                    <tbody id="hypestat-table-body">
                        <tr><td colspan="5" style="text-align:center; padding:40px;">📝 Введите URL и нажмите "Старт"</td></tr>
                    </tbody>
                </table>
            </div>
            <div class="log-area" id="hypestat-log"></div>
        `;

        document.body.appendChild(modal);

        const savedText = GM_getValue('last_input_text', '');
        if (savedText) document.getElementById('hypestat-urls').value = savedText;

        loadState();
        updateTable();
        updateCurrentDisplay();

        document.getElementById('hypestat-close').onclick = () => { modal.style.display = 'none'; };
        document.getElementById('hypestat-start').onclick = () => startChecking();
        document.getElementById('hypestat-stop').onclick = () => stopChecking();
        document.getElementById('hypestat-clear-table').onclick = () => clearAllData();
        document.getElementById('hypestat-copy-table').onclick = () => copyTableToClipboard();
        document.getElementById('hypestat-export').onclick = () => exportToCSV();

        makeDraggable(modal, modal.querySelector('.header'));
    }

    function makeDraggable(element, handle) {
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        let isDragging = false;
        handle.onmousedown = dragMouseDown;
        function dragMouseDown(e) {
            if (e.target === handle || handle.contains(e.target)) {
                e.preventDefault();
                isDragging = true;
                pos3 = e.clientX;
                pos4 = e.clientY;
                document.onmouseup = closeDragElement;
                document.onmousemove = elementDrag;
            }
        }
        function elementDrag(e) {
            if (!isDragging) return;
            e.preventDefault();
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            element.style.top = (element.offsetTop - pos2) + 'px';
            element.style.left = (element.offsetLeft - pos1) + 'px';
            element.style.position = 'fixed';
            element.style.margin = '0';
        }
        function closeDragElement() {
            isDragging = false;
            document.onmouseup = null;
            document.onmousemove = null;
        }
    }

    function parseUrlsFromInput() {
        const textarea = document.getElementById('hypestat-urls');
        return textarea.value.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => line.includes('://') ? line : 'https://' + line);
    }

    function clearAllData() {
        if (confirm('Очистить все данные?')) {
            currentQueue = []; currentIndex = 0; results = []; isRunning = false; stopRequested = false; isWaitingForCaptcha = false;
            clearState(); GM_setValue('hypestat_results', []);
            GM_setValue('last_input_text', '');
            updateTable(); updateCurrentDisplay();
            const textarea = document.getElementById('hypestat-urls');
            if (textarea) textarea.value = '';
            addLog('Все данные очищены');
        }
    }

    function exportToCSV() {
        if (currentQueue.length === 0) { alert('Нет данных для экспорта'); return; }
        const headers = ['URL', 'Домен', 'Посетители', 'Ошибка'];
        let csvContent = headers.join(';') + '\n';
        for (let i = 0; i < currentQueue.length; i++) {
            const sourceUrl = currentQueue[i];
            const result = results.find(r => r.source_url === sourceUrl);
            const domain = getDomainFromUrl(sourceUrl);
            const visitors = result?.visitors || '-';
            const error = result?.error || '-';
            const time = result?.timestamp ? new Date(result.timestamp).toLocaleString() : '-';
            const row = [sourceUrl, domain, visitors, error, time];
            const escapedRow = row.map(cell => cell.includes(';') || cell.includes('"') ? `"${cell.replace(/"/g, '""')}"` : cell);
            csvContent += escapedRow.join(';') + '\n';
        }
        const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `hypestat_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        addLog(`Экспортировано ${currentQueue.length} записей`);
    }

    // ==================== ОСНОВНАЯ ЛОГИКА ====================
    function nextSite() {
        currentIndex++;
        saveState();
        updateCurrentDisplay();
        if (currentIndex >= currentQueue.length) {
            addLog(`🎉 ГОТОВО! Обработано ${currentQueue.length} сайтов`);
            isRunning = false; stopRequested = false; isWaitingForCaptcha = false;
            clearState(); updateCurrentDisplay();
            return;
        }
        const nextDomain = getDomainFromUrl(currentQueue[currentIndex]);
        addLog(`➡️ Следующий: ${nextDomain} (${currentIndex + 1}/${currentQueue.length})`);
        setTimeout(() => {
            if (isRunning && !stopRequested) window.location.href = `https://hypestat.com/info/${nextDomain}`;
        }, CONFIG.DELAY_BETWEEN_REQUESTS);
    }

    function processCurrentPage() {
        if (!isRunning || stopRequested) return;
        if (currentIndex >= currentQueue.length) return;
        const currentUrl = currentQueue[currentIndex];
        const domain = getDomainFromUrl(currentUrl);
        if (!window.location.pathname.includes(domain)) {
            window.location.href = `https://hypestat.com/info/${domain}`;
            return;
        }
        pageLoadTime = Date.now();
        if (isCaptchaPresent() && !isWaitingForCaptcha) {
            isWaitingForCaptcha = true;
            addLog(`⚠️ Капча на ${domain}, пройдите проверку...`, true);
            updateCurrentDisplay();
            const checkInterval = setInterval(() => {
                if (!isCaptchaPresent()) {
                    clearInterval(checkInterval);
                    addLog(`✅ Капча решена для ${domain}`);
                    isWaitingForCaptcha = false;
                    location.reload();
                }
            }, 500);
            return;
        }
        const immediateResult = extractMonthlyVisitorsFromPage();
        if (immediateResult) {
            addLog(`✅ ${domain} → ${Number(immediateResult).toLocaleString()} посетителей (${Date.now() - pageLoadTime}мс)`);
            saveResult(currentUrl, domain, immediateResult);
            nextSite();
            return;
        }
        let attempts = 0;
        const fastInterval = setInterval(() => {
            if (!isRunning || stopRequested) { clearInterval(fastInterval); return; }
            const visitors = extractMonthlyVisitorsFromPage();
            if (visitors) {
                clearInterval(fastInterval);
                addLog(`✅ ${domain} → ${Number(visitors).toLocaleString()} посетителей (${Date.now() - pageLoadTime}мс)`);
                saveResult(currentUrl, domain, visitors);
                nextSite();
            } else {
                attempts++;
                if (attempts >= CONFIG.DATA_EXTRACT_ATTEMPTS) {
                    clearInterval(fastInterval);
                    addLog(`❌ ${domain} → данные не найдены (${Date.now() - pageLoadTime}мс)`, true);
                    saveResult(currentUrl, domain, '', 'Данные не найдены');
                    nextSite();
                }
            }
        }, CONFIG.EXTRACT_INTERVAL);
    }

    function startChecking() {
        const urls = parseUrlsFromInput();
        if (urls.length === 0) { alert('Введите хотя бы один URL'); return; }
        GM_setValue('last_input_text', document.getElementById('hypestat-urls').value);
        currentQueue = urls; currentIndex = 0; results = []; isRunning = true; stopRequested = false; isWaitingForCaptcha = false;
        saveState(); updateTable(); updateCurrentDisplay();
        addLog(`🚀 Старт! ${urls.length} сайтов в очереди`);
        window.location.href = `https://hypestat.com/info/${getDomainFromUrl(currentQueue[0])}`;
    }

    function stopChecking() {
        if (!isRunning) { alert('Процесс не запущен'); return; }
        stopRequested = true; isRunning = false; saveState();
        addLog(`⏹ Остановлено на ${currentIndex + 1}/${currentQueue.length}`);
        updateCurrentDisplay();
    }

    function init() {
        showMainWindow();
        if (window.location.hostname === 'hypestat.com' && window.location.pathname.includes('/info/')) {
            if (loadState() && isRunning && currentIndex < currentQueue.length) {
                addLog('⚡ Восстанавливаем активный процесс...');
                setTimeout(() => processCurrentPage(), 100);
            }
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
