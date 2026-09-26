# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## Unreleased

### Added

- 支持以 `precision-bench` 发布到 PyPI：新增 `precision-bench` 命令行入口（`--host/--port/--db/--reload`）、hatchling 打包配置（前端资源随包分发）、GitHub Release 触发的发布工作流与 Scorecard 分析工作流。
- README 徽章补齐至 7 枚：CI、Codecov 覆盖率、release、release date、last commit、license、python。
- 安全加固：Actions 依赖按 commit SHA 固定、Docker 基础镜像钉 digest、main 分支 ruleset 禁止 force push 与删除、SECURITY.md 补漏洞报告链接、OpenSSF Scorecard 工作流（Branch-Protection 0→3、Token-Permissions 0→10、Security-Policy 4→7）。
- 界面真实截图七张（性能压测、降智检测、缓存检测、逐请求、对比表、运行记录、日志）与 `docs/screenshots.md` 图集。
- `docs/DESIGN.md`：设计规范从根目录移入文档目录；首屏改用聚焦裁切图。
- 发布首个 GitHub Release（v0.3.0），release notes 附实测数据。
- CI 上传 `coverage.xml` 产物并尝试 Codecov 上传。

### Changed

- 服务与脚本统一为 Precision Bench：launchd label 改为 `com.marco.precisionbench`，日志改为 `~/Library/Logs/precision-bench.log`，`install` 会自动清理 0.3.0 之前的旧 label。
- PyPI 元数据补 13 条 trove classifiers。
- 依赖升级：actions/upload-artifact v7.0.1、codecov/codecov-action v7.1.1（由 Dependabot PR 合并，SHA pin 同步更新）。
- 新增 CodeQL 静态分析（Python + JavaScript），首次扫描无 security 级告警。
- 终态写库失败不再静默吞掉：运行与降智检测的收尾路径改为记录异常，避免历史里残留永远停在 running 的记录。
- 清理死代码与未用导入（providers 的 `last_ts`、cachecheck 的 `field`、bench_data 多余的 f 前缀）。
- 产品名统一为 Precision Bench：界面标题与左栏徽标、浏览器通知、Markdown 报告标题、告警文案。
- 顶栏与左栏的「运行 N」改为「记录」：该数字是内存中保留的运行记录数，原标签易被误读为正在运行数量。
- 移除手写的 tests / coverage 静态徽章（数字会随代码过期），改用 CI、release、license、python 四枚。
- `CITATION.cff` 移除（未发布到 Zenodo，无实际用途）。

### Added

- 新增英文 README、中文 `README.zh-CN.md` 与品牌 Logo，补充许可证、贡献指南、PR 模板等基础文件。
- 支持 Docker 运行：多阶段 `Dockerfile`（非 root、数据落在具名卷）、`docker-compose.yml`，CI 增加镜像构建。
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
