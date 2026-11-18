# 餐饮供应链召回采集服务

这是一个用于餐饮供应链召回的本地数据处理服务。它从仓库自带的合成来源读取数据，把召回通知与门店商品目录比对，输出按门店组织的处置清单。整个流程不访问外部系统，便于复现。

## 运行

需要 Node.js 20 或更高版本，不需要安装第三方依赖。

```sh
npm test
npm run build
node src/pipeline.mjs
```

测试使用项目内的合成记录；执行不需要网络、凭据或外部服务。

## 生成门店处置清单

```sh
# 最新修订
node src/disposition-cli.mjs --notice data/notice.json --catalog data/catalog.json

# 指定修订
node src/disposition-cli.mjs --notice data/notice.json --catalog data/catalog.json --revision 1

# 全部修订及相邻修订之间的差异
node src/disposition-cli.mjs --notice data/notice.json --catalog data/catalog.json --all-revisions
```

输出中每个门店分三块：

- `confirmed`：已确认需要召回处置的商品，`matchedLots` 列出命中的批次，`otherLots` 列出同商品但不在范围内的批次，方便门店只封存正确批次。
- `uncertain`：匹配不确定（名称相似度不够、规格冲突、门店未登记批次、同门店多个候选并列），必须人工核对，**不会**被写成已确认。
- `outOfScope`：商品身份已确认，但本修订的批次范围不含门店记录的批次；单独保留以便追溯为什么不再处置。

`unmatchedItems` 保留没能匹配上任何门店商品的通知条目和近似候选，供人工补录目录。

## 匹配规则

- 名称先归一化：全角/半角、大小写、标点、常见繁简字、`550ml`/`550毫升`、`五连包` 等包装写法差异都会被收敛。
- 条码或 SKU 一致视为商品身份确认；名称相似度达到阈值且规格不冲突也可确认。
- 规格冲突（如通知写 1L、目录写 500ml）或门店未登记批次时，只能进入 `uncertain`。
- 同一门店内多个候选分数并列时全部降级为 `uncertain`，不擅自挑一个。
- 批次范围支持单个批号、逗号分隔列表、`A001-A010` 区间、`2026-10-01 至 2026-10-15` 日期区间、`全部批次`；写坏的区间会直接报错，不会退化成单个批号。

## 修订

通知可以带多个 `revisions`，每个版本是该时点的完整快照。每次输出都从目标修订的完整条目重新计算，因此范围扩展/收窄时清单跟随对应版本：

- 扩展：新纳入的批次出现在新修订的 `matchedLots` 里，`--all-revisions` 的 `changes[].addedLots` 会单独列出。
- 收窄：移出的批次不再出现在新修订，`changes[].removedLots` 会单独列出；整个门店被移出时，从清单消失并进入差异的 `removed`。
- 条目顺序调整不会被误报为范围变化（按 SKU/条码/归一化名称识别条目）。
