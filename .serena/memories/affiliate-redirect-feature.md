# 推广链接跳转功能

## 功能描述
在 ListenHub 注册成功获取 Token 后，**立即**在后端访问配置的推广链接（affiliate URL），以建立推广关系，然后再执行签到和保存账户。

## 配置位置
- **配置文件**: `config.json` 中的 `affiliate.redirectUrl` 字段
- **前端设置**: 设置面板 -> 推广链接配置 -> 输入框 ID: `affiliate-url`
- **链接格式**: `https://labnana.com/?aff=your-code`

## 实现细节

### 后端 (server.js)
1. `loadConfig()` 函数默认值包含 `affiliate: { redirectUrl: '' }`
2. `GET /api/config` 返回 `affiliate` 配置
3. `POST /api/config` 支持保存 `affiliate` 配置
4. `registerOneAccount()` 函数流程：
   - 步骤 1-5: 生成邮箱、发送验证码、等待邮件、提取验证码、验证获取 Token
   - **步骤 6**: 访问推广链接（使用 fetch，携带 Token 作为认证）
   - 步骤 7: 获取积分
   - 步骤 8: 签到
   - 步骤 9: 保存账户

### 前端 (public/app.js)
1. `loadConfig()` 加载并显示 `affiliate.redirectUrl`
2. `saveConfig()` 保存 `affiliate.redirectUrl`
3. `autoRegister()` 只显示注册结果，不再打开链接（后端已处理）

### HTML (public/index.html)
- 设置面板中添加了推广链接配置区块
- 输入框 ID: `affiliate-url`
- placeholder: `https://labnana.com/?aff=your-code`

## 使用流程
1. 用户在设置面板填写推广链接（如 `https://labnana.com/?aff=6122b3a1c6944737`）
2. 点击保存配置
3. 执行自动注册
4. 后端在获取 Token 后自动访问推广链接
5. 然后执行签到和保存账户

## 注意事项
- 推广链接为空时不会访问
- 推广链接访问失败不会影响注册流程
- 访问时携带 Token 作为 Authorization header 和 Cookie