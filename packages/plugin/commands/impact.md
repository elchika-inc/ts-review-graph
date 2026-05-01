---
name: ts-review-graph:impact
description: 型名またはファイルパスを受け取り、変更の影響範囲を表示する
---

Arguments: `<type_name_or_file>`

If the argument ends with `.ts` or `.tsx`, call `get_impact` with `changed_file: <argument>`.
Otherwise, call `get_type_usages` with `type_name: <argument>`.

Display the result clearly.
