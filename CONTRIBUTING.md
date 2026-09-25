# Contributing to Precision Bench

感谢参与 Precision Bench（又称 LLM Bench）。这个项目优先保证**可复算、可解释、不会把失败伪装成成功**。

参与即表示同意 [行为准则](CODE_OF_CONDUCT.md)。修复、指标口径变更、UI 改版请先开 issue 讨论方向。

## 开发环境

```bash
uv sync --frozen --group dev
uv run --frozen pytest
```

启动本地服务：

```bash
./run.sh
```

## 提交约定

- 一类变更一个提交，提交信息说明行为变化。
- 不提交 API key、真实渠道 URL、运行数据库或用户数据。
- 性能/指标变更必须补测试，并说明统计口径变化。
- UI 变更至少检查 1720px、1024px、720px 三个视口。
- 不为了让测试通过而放宽断言、删除失败样本或隐藏告警。

## 本地检查

```bash
uv run --frozen pytest
uv run --frozen python -m compileall -q server tests
for file in web/*.js; do node --check "$file"; done
git diff --check
```

## 领域约定

- TTFT、TPOT、ITL、E2EL 的定义必须保持一致。
- 缓存必须区分：命中、未命中、写入、渠道未上报。
- 价格必须标明币种和 token 口径，缓存写入价不能默认为命中价。
- 主动缓存检测必须使用固定长前缀，第一轮写入不能被误报为命中。

## Pull Request

请说明：

1. 用户可感知的变化。
2. 复现方式或测试命令。
3. 指标口径、兼容性或安全影响。
4. 是否需要同步 README、截图和 CHANGELOG。
