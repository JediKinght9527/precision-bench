# Security Policy

## Supported version

当前主线是 `0.3.x`。安全修复优先发布到最新主线版本。

## Reporting a vulnerability

请不要在公开 Issue 中提交漏洞细节。使用 GitHub 仓库的 **Security → Report a vulnerability** 私下报告，或在修复前通过 maintainer 提供的安全渠道联系。

请尽量包含：

- 受影响版本和运行方式。
- 最小复现步骤。
- 是否可能泄露 API key、运行数据或内网访问权限。
- 已知影响范围和临时缓解方案。

## Security defaults

- 默认只监听 `127.0.0.1`。
- API key 不写入运行历史；API 出口会脱敏。
- 不建议直接把 `HOST=0.0.0.0` 暴露到公网。
- 局域网或公网部署必须放在带认证、访问控制和 TLS 的反向代理后。
- 目标 URL、模型名、Webhook 地址和用户自定义 Prompt 都应视为敏感输入。

报告安全问题不会因为“配置错误”而被忽略；如果服务默认边界本身不安全，也请直接报告。
