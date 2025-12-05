// ==UserScript==
// @name         香蕉实验室生图并发
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  在 Labnana (香蕉实验室) 网站上批量生成图片，支持图生图和文生图模式
// @author       苏糖
// @match        https://banana.listenhub.ai/*
// @icon         https://banana.listenhub.ai/favicon.ico
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // ==================== 配置 ====================
    const CONFIG = {
        API_BASE: 'https://api.listenhub.ai/api/v1/banana',
        IMAGE_SIZES: [
            { value: '1K', label: '1K · HD · 15 积分' },
            { value: '2K', label: '2K · Ultra · 15 积分' },
            { value: '4K', label: '4K · Extreme · 30 积分' }
        ],
        ASPECT_RATIOS: [
            { value: '1:1', label: '1:1 · 方形' },
            { value: '2:3', label: '2:3 · 照片' },
            { value: '3:2', label: '3:2 · 横版照片' },
            { value: '3:4', label: '3:4 · 竖版海报' },
            { value: '4:3', label: '4:3 · 传统横版' },
            { value: '9:16', label: '9:16 · 竖版' },
            { value: '16:9', label: '16:9 · 横版' },
            { value: '21:9', label: '21:9 · 超宽屏' }
        ],
        DEFAULT_INTERVAL: 1000,
        MIN_INTERVAL: 500
    };

    // ==================== 状态管理 ====================
    let state = {
        isRunning: false,
        authToken: null,
        uploadedImages: [],
        stats: { sent: 0, success: 0, failed: 0 },
        logs: [],
        // 多配置支持
        configs: [
            { id: 1, enabled: true, prompt: '', imageSize: '2K', aspectRatio: '1:1', isPublic: false, images: [] }
        ],
        nextConfigId: 2
    };

    // ==================== 工具函数 ====================
    // 获取当前积分
    function getCurrentCredits() {
        try {
            // 查找包含"积分:"文本的元素
            const elements = document.querySelectorAll('*');
            for (const el of elements) {
                if (el.children.length === 0 && el.textContent && el.textContent.includes('积分:')) {
                    const match = el.textContent.match(/积分:\s*(\d+)/);
                    if (match && match[1]) {
                        return parseInt(match[1]);
                    }
                }
            }
        } catch (e) {
            console.error('[香蕉实验室] 获取积分失败:', e);
        }
        return null;
    }

    function generateFileKey(file) {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 15);
        const extension = file.name.split('.').pop().toLowerCase();
        return `${timestamp}${random}.${extension}`;
    }

    function getContentType(file) {
        const ext = file.name.split('.').pop().toLowerCase();
        const types = { 'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'webp': 'image/webp' };
        return types[ext] || 'image/png';
    }

    function addLog(message, type = 'info') {
        const time = new Date().toLocaleTimeString();
        state.logs.unshift({ time, message, type });
        if (state.logs.length > 100) state.logs.pop();
        updateLogDisplay();
    }

    // ==================== Token 获取 ====================
    
    // 从 Cookie 获取 Token (主要方法)
    function getTokenFromCookie() {
        try {
            const cookies = document.cookie.split(';');
            for (const cookie of cookies) {
                const parts = cookie.trim().split('=');
                const name = parts[0];
                const value = parts.slice(1).join('='); // 处理值中可能包含 = 的情况
                
                // 专门查找 app_access_token
                if (name === 'app_access_token' && value) {
                    let decoded = decodeURIComponent(value);
                    // 移除 "Bearer " 或 "Bearer%20" 前缀
                    if (decoded.startsWith('Bearer ')) {
                        decoded = decoded.substring(7);
                    }
                    if (decoded.startsWith('eyJ') && decoded.length > 100) {
                        console.log('[香蕉实验室] Found token in app_access_token cookie');
                        return decoded;
                    }
                }
                
                // 也检查其他可能包含 JWT 的 cookie
                if (value) {
                    let decoded = decodeURIComponent(value);
                    if (decoded.startsWith('Bearer ')) {
                        decoded = decoded.substring(7);
                    }
                    if (decoded.startsWith('eyJ') && decoded.length > 100) {
                        console.log('[香蕉实验室] Found token in cookie:', name);
                        return decoded;
                    }
                }
            }
        } catch(e) {
            console.error('[香蕉实验室] Error reading cookies:', e);
        }
        return null;
    }
    
    // 从 localStorage 获取 Token
    function getTokenFromLocalStorage() {
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                const value = localStorage.getItem(key);
                if (value && value.startsWith('eyJ') && value.length > 100) {
                    console.log('[香蕉实验室] Found token in localStorage key:', key);
                    return value;
                }
                // 尝试解析 JSON
                try {
                    const parsed = JSON.parse(value);
                    if (parsed && typeof parsed === 'object') {
                        for (const k of Object.keys(parsed)) {
                            const v = parsed[k];
                            if (typeof v === 'string' && v.startsWith('eyJ') && v.length > 100) {
                                console.log('[香蕉实验室] Found token in localStorage JSON:', key, k);
                                return v;
                            }
                        }
                    }
                } catch(e) {}
            }
        } catch(e) {}
        return null;
    }
    
    // 从 sessionStorage 获取 Token
    function getTokenFromSessionStorage() {
        try {
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                const value = sessionStorage.getItem(key);
                if (value && value.startsWith('eyJ') && value.length > 100) {
                    return value;
                }
            }
        } catch(e) {}
        return null;
    }
    
    // 综合尝试获取 Token
    function tryGetToken() {
        // 1. 优先从 Cookie 获取 (最可靠的来源)
        const cookieToken = getTokenFromCookie();
        if (cookieToken) {
            state.authToken = cookieToken;
            try { GM_setValue('authToken', cookieToken); } catch(e) {}
            console.log('[香蕉实验室] Token from cookie (app_access_token)');
            return true;
        }
        
        // 2. 从 GM 存储获取 (缓存)
        try {
            const saved = GM_getValue('authToken', null);
            if (saved && saved.length > 50 && saved.startsWith('eyJ')) {
                state.authToken = saved;
                console.log('[香蕉实验室] Token from GM storage cache');
                return true;
            }
        } catch(e) {}
        
        // 3. 从 localStorage 获取
        const lsToken = getTokenFromLocalStorage();
        if (lsToken) {
            state.authToken = lsToken;
            try { GM_setValue('authToken', lsToken); } catch(e) {}
            console.log('[香蕉实验室] Token from localStorage');
            return true;
        }
        
        // 4. 从 sessionStorage 获取
        const ssToken = getTokenFromSessionStorage();
        if (ssToken) {
            state.authToken = ssToken;
            try { GM_setValue('authToken', ssToken); } catch(e) {}
            console.log('[香蕉实验室] Token from sessionStorage');
            return true;
        }
        
        return false;
    }
    
    // 拦截 fetch 请求
    function interceptToken() {
        const originalFetch = window.fetch;
        window.fetch = async function(...args) {
            const [url, options] = args;
            if (options && options.headers) {
                let auth = null;
                if (options.headers instanceof Headers) {
                    auth = options.headers.get('Authorization');
                } else if (typeof options.headers === 'object') {
                    auth = options.headers['authorization'] || options.headers['Authorization'];
                }
                if (auth && auth.startsWith('Bearer ')) {
                    const token = auth.replace('Bearer ', '');
                    if (token !== state.authToken && token.startsWith('eyJ')) {
                        state.authToken = token;
                        try { GM_setValue('authToken', token); } catch(e) {}
                        console.log('[香蕉实验室] Token captured from fetch');
                        updateTokenDisplay();
                        addLog('✅ 已自动捕获Token', 'success');
                    }
                }
            }
            return originalFetch.apply(this, args);
        };
        
        // 拦截 XMLHttpRequest
        const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
            if (name.toLowerCase() === 'authorization' && value && value.startsWith('Bearer ')) {
                const token = value.replace('Bearer ', '');
                if (token !== state.authToken && token.startsWith('eyJ')) {
                    state.authToken = token;
                    try { GM_setValue('authToken', token); } catch(e) {}
                    console.log('[香蕉实验室] Token captured from XHR');
                    updateTokenDisplay();
                }
            }
            return originalSetHeader.apply(this, arguments);
        };
    }
    
    // 手动设置 Token
    function promptForToken() {
        const token = prompt('请输入您的 Token（从浏览器开发者工具的网络请求中复制 Authorization 头的值，去掉 "Bearer " 前缀）：');
        if (token && token.trim().length > 50) {
            state.authToken = token.trim();
            try { GM_setValue('authToken', token.trim()); } catch(e) {}
            updateTokenDisplay();
            addLog('✅ Token已手动设置', 'success');
            return true;
        }
        return false;
    }

    // ==================== API 调用 ====================
    async function getUploadUrl(fileKey, contentType) {
        if (!state.authToken) {
            throw new Error('未获取到Token，请先在页面上进行一次正常操作');
        }
        const response = await fetch(`${CONFIG.API_BASE}/files`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${state.authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ fileKey, contentType })
        });
        if (response.status === 401) {
            state.authToken = null;
            try { GM_setValue('authToken', null); } catch(e) {}
            throw new Error('Token已过期(401)，请刷新页面后重新操作');
        }
        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.message || `获取上传URL失败: ${response.status}`);
        }
        return await response.json();
    }

    async function uploadToStorage(uploadUrl, file, contentType) {
        const response = await fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': contentType },
            body: file
        });
        if (!response.ok) throw new Error(`上传图片失败: ${response.status}`);
        return true;
    }

    async function uploadImage(file) {
        const fileKey = generateFileKey(file);
        const contentType = getContentType(file);
        addLog(`📤 正在上传图片: ${file.name}`, 'info');
        
        const response = await getUploadUrl(fileKey, contentType);
        console.log('[香蕉实验室] Upload URL response:', response);
        
        // API 返回格式: { code: 0, message: '', data: { presignedUrl, fileUrl } }
        const responseData = response.data || response;
        
        // 获取上传URL (presignedUrl)
        const uploadUrl = responseData.presignedUrl || responseData.uploadUrl || responseData.url || responseData.signedUrl;
        
        if (!uploadUrl) {
            console.error('[香蕉实验室] API response:', JSON.stringify(response));
            throw new Error('API未返回上传URL，请检查控制台日志');
        }
        
        await uploadToStorage(uploadUrl, file, contentType);
        addLog(`✅ 图片上传成功: ${file.name}`, 'success');
        
        // 获取文件的最终URL
        const fileUrl = responseData.fileUrl || responseData.file_url || uploadUrl.split('?')[0];
        return fileUrl;
    }

    async function generateImage(params) {
        const body = {
            prompt: params.prompt,
            imageSize: params.imageSize,
            aspectRatio: params.aspectRatio,
            isPublic: params.isPublic ?? false
        };
        if (params.referenceImageUrls && params.referenceImageUrls.length > 0) {
            body.referenceImageUrls = params.referenceImageUrls;
        }
        const response = await fetch(`${CONFIG.API_BASE}/images`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${state.authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) {
            if (data.message && (data.message.includes('积分') || data.message.includes('credit') || data.message.includes('insufficient'))) {
                throw new Error('INSUFFICIENT_CREDITS');
            }
            throw new Error(data.message || `生成失败: ${response.status}`);
        }
        return data;
    }

    // ==================== 批量生成 ====================
    async function startBatchGeneration() {
        if (state.isRunning) return;
        if (!state.authToken) {
            addLog('错误: 未获取到认证Token，请先在页面上进行一次操作', 'error');
            alert('未获取到认证Token，请先在页面上进行一次正常的生成操作');
            return;
        }

        const mode = document.querySelector('input[name="lb-mode"]:checked')?.value || 'text2img';
        const maxCount = parseInt(document.getElementById('lb-maxCount')?.value) || 0;
        const interval = Math.max(CONFIG.MIN_INTERVAL, parseInt(document.getElementById('lb-interval')?.value) || CONFIG.DEFAULT_INTERVAL);

        // 获取启用的配置
        const enabledConfigs = state.configs.filter(c => c.enabled && c.prompt.trim());
        
        if (enabledConfigs.length === 0) {
            addLog('错误: 请至少启用一个配置并填写提示词', 'error');
            alert('请至少启用一个配置并填写提示词');
            return;
        }

        // 检查图生图模式下的图片
        if (mode === 'img2img') {
            const missingImages = enabledConfigs.filter(c => !c.images || c.images.length === 0);
            if (missingImages.length > 0) {
                addLog(`错误: 有 ${missingImages.length} 个启用的配置未上传参考图片`, 'error');
                alert('图生图模式下，所有启用的配置都必须上传参考图片');
                return;
            }
        }

        state.isRunning = true;
        state.stats = { sent: 0, success: 0, failed: 0 };
        updateUI();
        addLog(`🚀 开始批量生成 - 模式: ${mode === 'img2img' ? '图生图' : '文生图'}, ${enabledConfigs.length} 个配置并发, 间隔: ${interval}ms`, 'info');

        let roundCount = 0;
        
        while (state.isRunning) {
            // 检查积分
            const credits = getCurrentCredits();
            if (credits !== null) {
                addLog(`💰 当前积分: ${credits}`, 'info');
                if (credits < 15) {
                    addLog('⚠️ 积分不足 15，停止批量生成', 'error');
                    alert('积分不足 15，无法继续生成，脚本已自动停止。');
                    break;
                }
            }

            roundCount++;
            
            // 检查是否达到最大轮次（每轮发送所有配置）
            if (maxCount > 0 && roundCount > maxCount) {
                addLog(`✅ 已达到最大轮次: ${maxCount}`, 'info');
                break;
            }
            
            addLog(`📤 第 ${roundCount} 轮: 并发发送 ${enabledConfigs.length} 个请求...`, 'info');
            
            // 并发发送所有启用的配置
            const promises = enabledConfigs.map(async (config, index) => {
                const params = {
                    referenceImageUrls: mode === 'img2img' ? config.images : null,
                    prompt: config.prompt,
                    imageSize: config.imageSize,
                    aspectRatio: config.aspectRatio,
                    isPublic: config.isPublic
                };
                
                try {
                    state.stats.sent++;
                    const result = await generateImage(params);
                    state.stats.success++;
                    const taskId = result.taskId || result.id || result.data?.taskId || result.data?.id || 'N/A';
                    addLog(`✅ 配置${index + 1} 成功, TaskID: ${taskId}`, 'success');
                    return { success: true, config: index + 1 };
                } catch (error) {
                    state.stats.failed++;
                    if (error.message === 'INSUFFICIENT_CREDITS') {
                        addLog(`💰 配置${index + 1} 积分不足`, 'error');
                        return { success: false, config: index + 1, insufficientCredits: true };
                    }
                    addLog(`❌ 配置${index + 1} 失败: ${error.message}`, 'error');
                    return { success: false, config: index + 1, error: error.message };
                }
            });
            
            const results = await Promise.all(promises);
            updateUI();
            
            // 检查是否有积分不足的情况
            if (results.some(r => r.insufficientCredits)) {
                addLog('💰 积分不足，停止批量生成', 'error');
                alert('积分不足，批量生成已停止');
                break;
            }
            
            // 检查是否全部失败
            if (results.every(r => !r.success) && state.stats.success === 0) {
                addLog('⚠️ 所有请求都失败，停止批量生成', 'error');
                break;
            }
            
            // 等待间隔
            if (state.isRunning) {
                await new Promise(r => setTimeout(r, interval));
            }
        }
        
        state.isRunning = false;
        updateUI();
        addLog(`🏁 批量生成结束 - 轮次: ${roundCount - 1}, 发送: ${state.stats.sent}, 成功: ${state.stats.success}, 失败: ${state.stats.failed}`, 'info');
    }

    function stopBatchGeneration() {
        state.isRunning = false;
        addLog('⏹️ 用户手动停止', 'info');
        updateUI();
    }

    // ==================== UI ====================
    function updateUI() {
        const startBtn = document.getElementById('lb-start-btn');
        const stopBtn = document.getElementById('lb-stop-btn');
        const statsEl = document.getElementById('lb-stats');
        if (startBtn) startBtn.disabled = state.isRunning;
        if (stopBtn) stopBtn.disabled = !state.isRunning;
        if (statsEl) statsEl.textContent = `已发送: ${state.stats.sent} | 成功: ${state.stats.success} | 失败: ${state.stats.failed}`;
    }

    function updateLogDisplay() {
        const logContainer = document.getElementById('lb-logs');
        if (!logContainer) return;
        logContainer.innerHTML = state.logs.slice(0, 50).map(log => {
            const cls = { 'info': 'lb-log-info', 'success': 'lb-log-success', 'error': 'lb-log-error' }[log.type];
            return `<div class="lb-log-item ${cls}">[${log.time}] ${log.message}</div>`;
        }).join('');
    }


    // 渲染配置列表
    function renderConfigs() {
        const container = document.getElementById('lb-configs-container');
        if (!container) return;
        
        const mode = document.querySelector('input[name="lb-mode"]:checked')?.value || 'text2img';
        
        container.innerHTML = state.configs.map((config, index) => `
            <div class="lb-config-item" data-id="${config.id}">
                <div class="lb-config-header">
                    <label class="lb-config-enable">
                        <input type="checkbox" class="lb-config-checkbox" data-id="${config.id}" ${config.enabled ? 'checked' : ''}>
                        <span>配置 ${index + 1}</span>
                    </label>
                    ${state.configs.length > 1 ? `<button class="lb-config-remove" data-id="${config.id}">×</button>` : ''}
                </div>
                <div class="lb-config-body ${config.enabled ? '' : 'lb-config-disabled'}">
                    ${mode === 'img2img' ? `
                    <div class="lb-config-images">
                        <input type="file" class="lb-config-file-input" data-id="${config.id}" accept="image/*" multiple style="display:none">
                        <button class="lb-config-upload-btn" data-id="${config.id}">📁 选择图片 (${config.images?.length || 0})</button>
                        ${config.images?.length > 0 ? `<button class="lb-config-clear-imgs" data-id="${config.id}">清空</button>` : ''}
                    </div>
                    ` : ''}
                    <textarea class="lb-config-prompt" data-id="${config.id}" placeholder="输入提示词...">${config.prompt || ''}</textarea>
                    <div class="lb-config-params">
                        <div class="lb-config-param-item">
                            <span class="lb-config-param-label">画质</span>
                            <select class="lb-config-size" data-id="${config.id}">
                                ${CONFIG.IMAGE_SIZES.map(s => `<option value="${s.value}" ${config.imageSize === s.value ? 'selected' : ''}>${s.label}</option>`).join('')}
                            </select>
                        </div>
                        <div class="lb-config-param-item">
                            <span class="lb-config-param-label">比例</span>
                            <select class="lb-config-ratio" data-id="${config.id}">
                                ${CONFIG.ASPECT_RATIOS.map(r => `<option value="${r.value}" ${config.aspectRatio === r.value ? 'selected' : ''}>${r.label}</option>`).join('')}
                            </select>
                        </div>
                    </div>
                    <div class="lb-config-public" style="margin-top: 10px;">
                        <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;">
                            <input type="checkbox" class="lb-config-public-checkbox" data-id="${config.id}" ${config.isPublic ? 'checked' : ''} style="width: 14px; height: 14px; cursor: pointer;">
                            <span style="font-size: 12px; color: #666;">公开到图库</span>
                        </label>
                    </div>
                </div>
            </div>
        `).join('');
        
        // 绑定配置事件
        bindConfigEvents();
    }

    function bindConfigEvents() {
        // 启用/禁用配置
        document.querySelectorAll('.lb-config-checkbox').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const id = parseInt(e.target.dataset.id);
                const config = state.configs.find(c => c.id === id);
                if (config) {
                    config.enabled = e.target.checked;
                    renderConfigs();
                }
            });
        });
        
        // 删除配置
        document.querySelectorAll('.lb-config-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = parseInt(e.target.dataset.id);
                state.configs = state.configs.filter(c => c.id !== id);
                renderConfigs();
            });
        });
        
        // 配置图片上传按钮
        document.querySelectorAll('.lb-config-upload-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.target.dataset.id;
                document.querySelector(`.lb-config-file-input[data-id="${id}"]`)?.click();
            });
        });
        
        // 配置图片文件选择
        document.querySelectorAll('.lb-config-file-input').forEach(input => {
            input.addEventListener('change', async (e) => {
                const id = parseInt(e.target.dataset.id);
                const config = state.configs.find(c => c.id === id);
                if (!config) return;
                
                const files = Array.from(e.target.files);
                if (!files.length) return;
                
                const btn = document.querySelector(`.lb-config-upload-btn[data-id="${id}"]`);
                if (btn) {
                    btn.disabled = true;
                    btn.textContent = '⏳ 上传中...';
                }
                
                try {
                    for (const file of files) {
                        const url = await uploadImage(file);
                        if (!config.images) config.images = [];
                        config.images.push(url);
                    }
                    addLog(`✅ 配置${state.configs.indexOf(config) + 1} 上传了 ${files.length} 张图片`, 'success');
                } catch (err) {
                    addLog(`❌ 配置图片上传失败: ${err.message}`, 'error');
                } finally {
                    e.target.value = '';
                    renderConfigs();
                }
            });
        });
        
        // 清空配置图片
        document.querySelectorAll('.lb-config-clear-imgs').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = parseInt(e.target.dataset.id);
                const config = state.configs.find(c => c.id === id);
                if (config) {
                    config.images = [];
                    renderConfigs();
                }
            });
        });
        
        // 提示词变化
        document.querySelectorAll('.lb-config-prompt').forEach(textarea => {
            textarea.addEventListener('input', (e) => {
                const id = parseInt(e.target.dataset.id);
                const config = state.configs.find(c => c.id === id);
                if (config) config.prompt = e.target.value;
            });
        });
        
        // 画质变化
        document.querySelectorAll('.lb-config-size').forEach(select => {
            select.addEventListener('change', (e) => {
                const id = parseInt(e.target.dataset.id);
                const config = state.configs.find(c => c.id === id);
                if (config) config.imageSize = e.target.value;
            });
        });
        
        // 比例变化
        document.querySelectorAll('.lb-config-ratio').forEach(select => {
            select.addEventListener('change', (e) => {
                const id = parseInt(e.target.dataset.id);
                const config = state.configs.find(c => c.id === id);
                if (config) config.aspectRatio = e.target.value;
            });
        });

        // 公开选项变化
        document.querySelectorAll('.lb-config-public-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                const id = parseInt(e.target.dataset.id);
                const config = state.configs.find(c => c.id === id);
                if (config) config.isPublic = e.target.checked;
            });
        });

    }

    function addNewConfig() {
        state.configs.push({
            id: state.nextConfigId++,
            enabled: true,
            prompt: '',
            imageSize: '2K',
            aspectRatio: '1:1',
            isPublic: false
        });
        renderConfigs();
    }

    function updateTokenDisplay() {
        const el = document.getElementById('lb-token-status');
        if (el) {
            if (state.authToken) {
                el.textContent = '✅ Token已获取';
                el.className = 'lb-token-ok';
            } else {
                el.textContent = '❌ 未获取Token';
                el.className = 'lb-token-no';
            }
        }
    }

    function createControlPanel() {
        // 创建主面板
        const panel = document.createElement('div');
        panel.id = 'lb-control-panel';
        panel.innerHTML = `
            <div class="lb-header">
                <span class="lb-title">🍌 香蕉实验室生图并发</span>
                <div class="lb-header-btns">
                    <button id="lb-zoom-out" class="lb-zoom-btn" title="缩小">−</button>
                    <span id="lb-zoom-level">100%</span>
                    <button id="lb-zoom-in" class="lb-zoom-btn" title="放大">+</button>
                    <button id="lb-minimize-btn" class="lb-toggle-btn" title="最小化">_</button>
                </div>
            </div>
            <div id="lb-content" class="lb-content">
                <div class="lb-section lb-token-row">
                    <span id="lb-token-status" class="${state.authToken ? 'lb-token-ok' : 'lb-token-no'}">${state.authToken ? '✅ Token已获取' : '❌ 未获取Token'}</span>
                    <button id="lb-refresh-token" class="lb-btn-mini">刷新</button>
                    <button id="lb-manual-token" class="lb-btn-mini">手动</button>
                    <button id="lb-clear-token" class="lb-btn-mini">清除</button>
                </div>
                <div class="lb-section">
                    <div class="lb-label">生成模式</div>
                    <div class="lb-radio-group">
                        <label><input type="radio" name="lb-mode" value="img2img" checked> 🖼️ 图生图</label>
                        <label><input type="radio" name="lb-mode" value="text2img"> 📝 文生图</label>
                    </div>
                </div>
                <div class="lb-section">
                    <div class="lb-label">
                        配置列表
                        <button id="lb-add-config" class="lb-btn-mini" style="margin-left:10px">+ 添加配置</button>
                    </div>
                    <div id="lb-configs-container"></div>
                </div>
                <div class="lb-section">
                    <div class="lb-label">批量设置</div>
                    <div class="lb-params">
                        <div class="lb-param"><span>轮次(0=无限)</span><input type="number" id="lb-maxCount" class="lb-input" value="0" min="0" title="每轮并发发送所有启用的配置"></div>
                        <div class="lb-param"><span>间隔(ms)</span><input type="number" id="lb-interval" class="lb-input" value="1000" min="500" title="每轮之间的间隔时间"></div>
                    </div>
                    <div class="lb-hint">💡 每轮会并发发送所有启用的配置</div>
                </div>
                <div class="lb-section lb-buttons">
                    <button id="lb-start-btn" class="lb-btn lb-btn-primary">▶️ 开始生成</button>
                    <button id="lb-stop-btn" class="lb-btn lb-btn-danger" disabled>⏹️ 停止</button>
                </div>
                <div class="lb-section"><div id="lb-stats" class="lb-stats">已发送: 0 | 成功: 0 | 失败: 0</div></div>
                <div class="lb-section">
                    <div class="lb-label">运行日志</div>
                    <div id="lb-logs" class="lb-logs"></div>
                </div>
                <div class="lb-footer">by 苏糖 ❤️</div>
            </div>`;
        
        // 创建最小化按钮（默认隐藏）
        const minBtn = document.createElement('div');
        minBtn.id = 'lb-minimized-btn';
        minBtn.innerHTML = '🍌';
        minBtn.title = '展开香蕉实验室助手';
        minBtn.style.display = 'none';
        
        document.body.appendChild(panel);
        document.body.appendChild(minBtn);
        
        bindEvents();
        makeDraggable(panel);
        makeDraggable(minBtn); // 让最小化按钮也可以拖动
    }

    function bindEvents() {
        // 最小化
        document.getElementById('lb-minimize-btn')?.addEventListener('click', () => {
            document.getElementById('lb-control-panel').style.display = 'none';
            document.getElementById('lb-minimized-btn').style.display = 'flex';
        });
        
        // 展开
        document.getElementById('lb-minimized-btn')?.addEventListener('click', () => {
            document.getElementById('lb-minimized-btn').style.display = 'none';
            document.getElementById('lb-control-panel').style.display = 'block';
        });
        
        document.getElementById('lb-refresh-token')?.addEventListener('click', () => {
            if (tryGetToken()) {
                updateTokenDisplay();
                addLog('✅ Token刷新成功', 'success');
            } else {
                addLog('❌ 未找到Token，请在页面上进行一次操作或手动输入', 'error');
            }
        });
        
        document.getElementById('lb-manual-token')?.addEventListener('click', () => {
            promptForToken();
        });
        
        document.getElementById('lb-clear-token')?.addEventListener('click', () => {
            state.authToken = null;
            try { GM_setValue('authToken', null); } catch(e) {}
            updateTokenDisplay();
            addLog('🗑️ Token已清除', 'info');
        });
        
        // 缩放功能
        let zoomLevel = GM_getValue('zoomLevel', 100);
        applyZoom(zoomLevel);
        
        document.getElementById('lb-zoom-in')?.addEventListener('click', () => {
            zoomLevel = Math.min(150, zoomLevel + 10);
            applyZoom(zoomLevel);
            GM_setValue('zoomLevel', zoomLevel);
        });
        
        document.getElementById('lb-zoom-out')?.addEventListener('click', () => {
            zoomLevel = Math.max(50, zoomLevel - 10);
            applyZoom(zoomLevel);
            GM_setValue('zoomLevel', zoomLevel);
        });
        
        function applyZoom(level) {
            const panel = document.getElementById('lb-control-panel');
            if (panel) {
                panel.style.transform = `scale(${level / 100})`;
                panel.style.transformOrigin = 'top right';
            }
            const levelEl = document.getElementById('lb-zoom-level');
            if (levelEl) levelEl.textContent = level + '%';
        }
        
        document.querySelectorAll('input[name="lb-mode"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                renderConfigs(); // 重新渲染配置以显示/隐藏图片上传
            });
        });
        document.getElementById('lb-start-btn')?.addEventListener('click', startBatchGeneration);
        document.getElementById('lb-stop-btn')?.addEventListener('click', stopBatchGeneration);
        
        // 添加配置按钮
        document.getElementById('lb-add-config')?.addEventListener('click', addNewConfig);
        
        // 初始渲染配置列表
        renderConfigs();
    }

    // 使面板可拖动
    function makeDraggable(element) {
        const header = element.querySelector('.lb-header') || element; // 如果没有 header，则整个元素可拖动
        let isDragging = false;
        let offsetX, offsetY;

        header.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('lb-toggle-btn')) return;
            // 如果是最小化按钮，防止点击事件冲突
            if (element.id === 'lb-minimized-btn' && e.target !== element) return;
            
            isDragging = true;
            offsetX = e.clientX - element.offsetLeft;
            offsetY = e.clientY - element.offsetTop;
            header.style.cursor = 'grabbing';
            
            // 防止选中文本
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            
            let newLeft = e.clientX - offsetX;
            let newTop = e.clientY - offsetY;
            
            // 边界检查
            const maxX = window.innerWidth - element.offsetWidth;
            const maxY = window.innerHeight - element.offsetHeight;
            
            newLeft = Math.max(0, Math.min(newLeft, maxX));
            newTop = Math.max(0, Math.min(newTop, maxY));
            
            element.style.left = newLeft + 'px';
            element.style.top = newTop + 'px';
            element.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                header.style.cursor = 'grab';
                // 如果是最小化按钮，保存位置
                if (element.id === 'lb-minimized-btn') {
                    // 可以在这里保存位置到 GM_setValue
                }
            }
        });
    }

    function addStyles() {
        GM_addStyle(`
            #lb-control-panel {
                position: fixed;
                top: 80px;
                right: 20px;
                width: 340px;
                background: linear-gradient(135deg, #ff9a56 0%, #ff6b35 100%);
                border-radius: 16px;
                box-shadow: 0 10px 40px rgba(255, 107, 53, 0.3);
                z-index: 10000;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', sans-serif;
                color: #fff;
                font-size: 13px;
                overflow: hidden;
            }
            .lb-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 14px 16px;
                background: rgba(0,0,0,0.15);
                cursor: grab;
            }
            .lb-header:active { cursor: grabbing; }
            .lb-title {
                font-weight: 700;
                font-size: 14px;
                color: #fff;
                text-shadow: 0 1px 2px rgba(0,0,0,0.2);
            }
            .lb-header-btns {
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .lb-zoom-btn {
                background: rgba(255,255,255,0.25);
                border: none;
                color: #fff;
                width: 24px;
                height: 24px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 16px;
                font-weight: bold;
            }
            .lb-zoom-btn:hover { background: rgba(255,255,255,0.4); }
            #lb-zoom-level {
                color: rgba(255,255,255,0.9);
                font-size: 11px;
                min-width: 36px;
                text-align: center;
            }
            .lb-toggle-btn {
                background: rgba(255,255,255,0.25);
                border: none;
                color: #fff;
                width: 28px;
                height: 28px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 14px;
            }
            .lb-toggle-btn:hover { background: rgba(255,255,255,0.4); }
            .lb-content {
                padding: 16px;
                max-height: 65vh;
                overflow-y: auto;
                background: #fffaf7;
                color: #333;
            }
            .lb-content::-webkit-scrollbar { width: 6px; }
            .lb-content::-webkit-scrollbar-thumb { background: #ff9a56; border-radius: 3px; }
            .lb-section {
                margin-bottom: 16px;
            }
            .lb-token-row {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 10px 12px;
                background: #fff;
                border-radius: 10px;
                flex-wrap: wrap;
                border: 1px solid #ffe0d0;
            }
            .lb-token-ok {
                color: #28a745;
                font-weight: 600;
                font-size: 12px;
            }
            .lb-token-no {
                color: #dc3545;
                font-weight: 600;
                font-size: 12px;
            }
            .lb-btn-mini {
                background: #ff6b35;
                border: none;
                color: #fff;
                padding: 5px 10px;
                border-radius: 6px;
                font-size: 11px;
                cursor: pointer;
                transition: all 0.2s;
            }
            .lb-btn-mini:hover { background: #e55a2b; transform: translateY(-1px); }
            .lb-label {
                font-weight: 600;
                margin-bottom: 8px;
                color: #ff6b35;
                font-size: 12px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                display: flex;
                align-items: center;
            }
            .lb-radio-group {
                display: flex;
                gap: 12px;
            }
            .lb-radio-group label {
                display: flex;
                align-items: center;
                gap: 6px;
                cursor: pointer;
                padding: 8px 14px;
                background: #fff;
                border-radius: 8px;
                border: 2px solid #ffe0d0;
                transition: all 0.2s;
                font-size: 12px;
            }
            .lb-radio-group label:hover { border-color: #ff9a56; }
            .lb-radio-group label:has(input:checked) {
                background: linear-gradient(135deg, #ff9a56 0%, #ff6b35 100%);
                color: #fff;
                border-color: transparent;
            }
            .lb-textarea {
                width: 100%;
                height: 90px;
                min-height: 60px;
                padding: 12px;
                border: 2px solid #ffe0d0;
                border-radius: 10px;
                background: #fff;
                color: #333;
                resize: vertical;
                font-size: 13px;
                box-sizing: border-box;
                transition: border-color 0.2s;
            }
            .lb-textarea:focus { outline: none; border-color: #ff9a56; }
            .lb-textarea::placeholder { color: #ccc; }
            .lb-params {
                display: flex;
                flex-direction: column;
                gap: 10px;
            }
            .lb-param {
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .lb-param span { color: #888; font-size: 12px; }
            .lb-select, .lb-input {
                padding: 8px 12px;
                border: 2px solid #ffe0d0;
                border-radius: 8px;
                background: #fff;
                color: #333;
                font-size: 12px;
                transition: border-color 0.2s;
            }
            .lb-select { min-width: 140px; }
            .lb-input { width: 80px; text-align: center; }
            .lb-select:focus, .lb-input:focus { outline: none; border-color: #ff9a56; }
            .lb-buttons {
                display: flex;
                gap: 10px;
            }
            .lb-btn {
                flex: 1;
                padding: 12px 16px;
                border: none;
                border-radius: 10px;
                cursor: pointer;
                font-weight: 600;
                font-size: 13px;
                transition: all 0.2s;
            }
            .lb-btn:disabled { opacity: 0.5; cursor: not-allowed; }
            .lb-btn-primary {
                background: linear-gradient(135deg, #ff9a56 0%, #ff6b35 100%);
                color: #fff;
            }
            .lb-btn-primary:hover:not(:disabled) {
                transform: translateY(-2px);
                box-shadow: 0 6px 20px rgba(255, 107, 53, 0.4);
            }
            .lb-btn-secondary {
                background: #fff;
                color: #ff6b35;
                border: 2px solid #ff6b35;
            }
            .lb-btn-secondary:hover:not(:disabled) { background: #ff6b35; color: #fff; }
            .lb-btn-danger {
                background: linear-gradient(135deg, #ff6b6b 0%, #ee5a5a 100%);
                color: #fff;
            }
            .lb-btn-danger:hover:not(:disabled) {
                transform: translateY(-2px);
                box-shadow: 0 6px 20px rgba(238, 90, 90, 0.4);
            }
            .lb-stats {
                text-align: center;
                padding: 12px;
                background: linear-gradient(135deg, #ff9a56 0%, #ff6b35 100%);
                border-radius: 10px;
                color: #fff;
                font-weight: 600;
                font-size: 12px;
            }
            .lb-logs {
                height: 120px;
                overflow-y: auto;
                background: #fff;
                border-radius: 10px;
                padding: 10px;
                font-size: 11px;
                font-family: 'SF Mono', Monaco, monospace;
                border: 1px solid #ffe0d0;
            }
            .lb-log-item { padding: 3px 0; border-bottom: 1px solid #fff5f0; }
            .lb-log-info { color: #888; }
            .lb-log-success { color: #28a745; }
            .lb-log-error { color: #dc3545; }
            .lb-image-list { margin-top: 8px; }
            .lb-image-item {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 8px 12px;
                background: #fff;
                border-radius: 8px;
                margin-bottom: 6px;
                font-size: 12px;
                border: 1px solid #ffe0d0;
            }
            .lb-remove-img {
                background: #ff6b6b;
                color: #fff;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                padding: 4px 10px;
                font-size: 12px;
            }
            .lb-remove-img:hover { background: #ee5a5a; }
            .lb-no-images {
                color: #ccc;
                padding: 12px;
                text-align: center;
                font-size: 12px;
            }
            .lb-footer {
                text-align: center;
                padding: 12px;
                color: #ff6b35;
                font-size: 11px;
                border-top: 1px solid #ffe0d0;
                margin-top: 12px;
            }
            
            /* 最小化按钮样式 */
            #lb-minimized-btn {
                position: fixed;
                top: 80px;
                right: 20px;
                width: 48px;
                height: 48px;
                background: linear-gradient(135deg, #ff9a56 0%, #ff6b35 100%);
                border-radius: 50%;
                box-shadow: 0 4px 12px rgba(255, 107, 53, 0.4);
                z-index: 10000;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 24px;
                cursor: pointer;
                transition: transform 0.2s;
                border: 2px solid #fff;
            }
            #lb-minimized-btn:hover {
                transform: scale(1.1);
            }
            
            /* 多配置样式 */
            .lb-config-item {
                background: #fff;
                border-radius: 12px;
                margin-bottom: 12px;
                overflow: hidden;
                border: 1px solid #ffe0d0;
                box-shadow: 0 2px 8px rgba(0,0,0,0.05);
                transition: transform 0.2s, box-shadow 0.2s;
            }
            .lb-config-item:hover {
                transform: translateY(-1px);
                box-shadow: 0 4px 12px rgba(0,0,0,0.08);
            }
            .lb-config-item:last-child {
                margin-bottom: 0;
            }
            .lb-config-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px 14px;
                background: linear-gradient(135deg, #ff9a56 0%, #ff6b35 100%);
                color: #fff;
            }
            .lb-config-enable {
                display: flex;
                align-items: center;
                gap: 8px;
                cursor: pointer;
                font-size: 13px;
                font-weight: 600;
                user-select: none;
            }
            .lb-config-checkbox {
                width: 16px;
                height: 16px;
                cursor: pointer;
                accent-color: #fff;
            }
            .lb-config-remove {
                background: rgba(255,255,255,0.2);
                border: none;
                color: #fff;
                width: 24px;
                height: 24px;
                border-radius: 50%;
                cursor: pointer;
                font-size: 16px;
                line-height: 1;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: background 0.2s;
            }
            .lb-config-remove:hover {
                background: #ff4d4d;
            }
            .lb-config-body {
                padding: 12px;
            }
            .lb-config-body.lb-config-disabled {
                opacity: 0.6;
                pointer-events: none;
                filter: grayscale(0.5);
            }
            .lb-config-images {
                display: flex;
                gap: 8px;
                margin-bottom: 10px;
                align-items: center;
            }
            .lb-config-upload-btn {
                background: #fff;
                border: 1px dashed #ff9a56;
                color: #ff6b35;
                padding: 8px 12px;
                border-radius: 8px;
                font-size: 12px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s;
                flex: 1;
                text-align: center;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
            }
            .lb-config-upload-btn:hover {
                background: #fff5f0;
                border-style: solid;
                transform: translateY(-1px);
            }
            .lb-config-clear-imgs {
                background: #ffe0d0;
                border: none;
                color: #ff6b35;
                padding: 8px 12px;
                border-radius: 8px;
                font-size: 12px;
                font-weight: 500;
                cursor: pointer;
                transition: background 0.2s;
            }
            .lb-config-clear-imgs:hover {
                background: #ffccb0;
            }
            .lb-config-prompt {
                width: 100%;
                height: 70px;
                padding: 10px;
                border: 1px solid #e0e0e0;
                border-radius: 8px;
                background: #fcfcfc;
                color: #333;
                resize: vertical;
                font-size: 13px;
                line-height: 1.4;
                box-sizing: border-box;
                margin-bottom: 10px;
                transition: border-color 0.2s, box-shadow 0.2s;
            }
            .lb-config-prompt:focus {
                outline: none;
                border-color: #ff9a56;
                background: #fff;
                box-shadow: 0 0 0 3px rgba(255, 154, 86, 0.1);
            }
            .lb-config-params {
                display: flex;
                gap: 10px;
                flex-wrap: wrap;
            }
            .lb-config-param-item {
                flex: 1;
                min-width: 80px;
                display: flex;
                flex-direction: column;
                gap: 4px;
            }
            .lb-config-param-label {
                font-size: 11px;
                color: #666;
                padding-left: 2px;
                font-weight: 500;
            }
            .lb-config-params select {
                padding: 8px 10px;
                border: 1px solid #e0e0e0;
                border-radius: 8px;
                background: #fff;
                color: #333;
                font-size: 12px;
                font-weight: 500;
                flex: 1;
                min-width: 70px;
                cursor: pointer;
                transition: border-color 0.2s, box-shadow 0.2s;
                appearance: none;
                background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23ff6b35' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
                background-repeat: no-repeat;
                background-position: right 8px center;
                background-size: 12px;
                padding-right: 24px;
            }
            .lb-config-params select:focus {
                outline: none;
                border-color: #ff9a56;
                box-shadow: 0 0 0 3px rgba(255, 154, 86, 0.1);
            }
            .lb-config-params select option {
                font-size: 13px;
                padding: 6px;
            }
            .lb-hint {
                font-size: 11px;
                color: #ff6b35;
                margin-top: 8px;
                padding: 6px 10px;
                background: #fff5f0;
                border-radius: 6px;
                border: 1px solid #ffe0d0;
            }
        `);
    }

    // ==================== 初始化 ====================
    function init() {
        console.log('[香蕉实验室生图并发] 脚本加载中...');
        
        // 立即开始拦截 Token
        interceptToken();
        
        // 等待 DOM 加载完成后创建 UI
        function createUI() {
            if (document.body) {
                // 尝试获取 Token
                tryGetToken();
                
                addStyles();
                createControlPanel();
                
                if (state.authToken) {
                    addLog('🍌 脚本已加载，Token已获取', 'success');
                } else {
                    addLog('🍌 脚本已加载', 'info');
                    addLog('💡 请点击"刷新"按钮或在页面上进行一次操作', 'info');
                }
            } else {
                setTimeout(createUI, 100);
            }
        }
        
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => setTimeout(createUI, 1000));
        } else {
            setTimeout(createUI, 1000);
        }
    }

    // 立即执行初始化
    init();
})();