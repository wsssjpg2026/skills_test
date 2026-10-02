# Domain Docs

工程技能在探索代码库时应如何消费本仓库的领域文档。

## 探索前先读

- 根目录 **`GLOSSARY.md`**；若存在 **`GLOSSARY-MAP.md`**（多上下文仓库），按主题读各上下文的 `GLOSSARY.md`
- **`docs/adr/`**：读与将要工作的区域相关的 ADR

这些文件不存在时**静默继续**：不要提示缺失，也不要建议预先创建。`/domain-modeling` 技能（经 `/grill-with-docs`、`/improve-codebase-architecture` 触达）会在术语或决策实际落定时惰性创建它们。

## 文件结构

单上下文仓库（本仓库）：

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-xxx.md
│   └── 0002-yyy.md
└── src/
```

## 使用词汇表的术语

输出中命名领域概念时（issue 标题、重构提案、假设、测试名），使用 `GLOSSARY.md` 定义的术语，不要漂移到词汇表明确回避的同义词。

若所需概念不在词汇表中，这是一个信号：要么你在发明项目不用的语言（重新考虑），要么存在真实缺口（记下来给 `/domain-modeling`）。

## 标记 ADR 冲突

输出与既有 ADR 矛盾时显式标出，而不是静默覆盖：

> _与 ADR-0007（xxx）矛盾，但值得重开，因为……_
