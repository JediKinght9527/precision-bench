# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## Unreleased

### Added

- GitHub 发布整备：英文主 README、中文 `README.zh-CN.md`、品牌 Logo、PR 模板、行为准则、CODEOWNERS。
- Docker 一键运行：多阶段 `Dockerfile`（非 root、具名卷持久化）、`docker-compose.yml`、CI 镜像构建校验。
- 渠道验真报告：汇总性能、缓存、降智、SLO 和成本证据，可复制/下载 Markdown。
- 本地测试方案保存与载入，不保存 API key。
- 缓存友好模式：固定前缀、至少一次预热，让正式采样有机会从首轮命中缓存。
- 缓存检测后台任务、取消、分页历史和原始地址脱敏。
- Qwen、GLM、DeepSeek、Kimi、Anthropic 缓存门槛预设。
- TLS、system prompt、top_p、输入分布、ramp/cooldown、worker ramp 和缓存写入价格配置。

### Changed

- RPS 默认表示成功请求/墙钟，详情同时显示尝试 RPS。
- Anthropic 非流式 token 统计将 cache read/write 纳入总输入。
- 成本估算区分普通输入、缓存读取、缓存写入和输出。

## 0.3.0

- 初始公开版本：性能压测、缓存检测、降智检测、基线、历史、导出、定时巡检和中国大陆渠道适配。
