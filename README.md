# Tixing.Orz.lc - 多用户提醒推送系统

基于 Cloudflare Workers + D1 数据库的轻量多用户提醒推送服务，通过 Pushplus 渠道定时发送通知。提供完整的前端管理界面，支持用户注册、多令牌管理、周期性提醒等功能。

## 主要功能

- **用户系统**：注册、登录、令牌鉴权;
- **Pushplus 令牌管理**：添加、删除、测试推送令牌;
- **提醒管理**：
  - 创建定时提醒（支持单次/循环）;
  - 设置开始时间、间隔小时（1‑8999 整数）;
  - 手动完成或删除提醒;
- **定时推送**：通过 Cloudflare Cron Triggers 自动扫描到期提醒，调用 Pushplus API 发送;
- **响应式前端**：内嵌单页应用，适配电脑与手机;

## 技术栈

- **运行时**：Cloudflare Workers
- **数据库**：Cloudflare D1（SQLite 兼容）;
- **前端**：原生 HTML/CSS/JS（内嵌于 Worker）;
- **推送渠道**：Pushplus (pushplus.plus);

## 注意事项
- 密码采用简单 SHA-256，无加盐，请勿用于生产环境。
- 动态内容依赖于 Cloudflare D1，确保 D1 数据库有足够配额。
- 定时触发依赖 Cloudflare Workers Cron Triggers（需套餐支持）。

![webpage-01](/IMG/webpage-01.png)
![webpage-02](/IMG/webpage-02.png)
![webpage-03](/IMG/webpage-03.png)
--- ---
- 全部代码均由DeepSeek生成, 不保证可用性
