# 商业授权与使用边界说明 / Commercial Licensing & Scope Guide

**版权方 / Copyright Holder**: `OctoLab (Octo-o-o-o)`  
**商业授权联系邮箱 / Commercial Licensing Contact**: [`octoooo@octoooo.com`](mailto:octoooo@octoooo.com)  
**适用软件范围 / Covered Software**: `dsh-self` 仓库内全部原创源码、插件包（`dsh-self-studio`）、核心库（`@dsh-self/product-spec`、`@dsh-self/catalog`、`@dsh-self/adapters`）、桌面壳模板与内置壳插件（`templates/desktop`、`dsh-shell-product`、`dsh-theme-product`）、构建工具链（`tools/builder`、`tools/dsh-client-build`）、以及**嵌入在由本工具生成的独立桌面客户端安装包内的上述原创运行时与适配器代码**。

---

## 一、使用场景授权对照表 / Quick Eligibility Matrix

| 使用场景 / Scenario | 是否免费 / Free? | 适用协议与条件 / Applicable License & Conditions |
| --- | --- | --- |
| **个人自用与非商业分享**（把自己的 DSH 场景打包成桌面客户端自用、无偿分享给亲友或开源社区、学术研究）<br>*Personal use, free non-paywalled sharing, academic research* | **免费允许 (FREE)** | 适用 [`LICENSE`](LICENSE) 中的 **PolyForm Noncommercial License 1.0.0**，无需申请。分发时须保留版权声明与协议文件。 |
| **公益/教育/科研/政府等非营利机构使用**<br>*Charitable, educational, public research, or government institutions* | **免费允许 (FREE)** | 适用 **PolyForm Noncommercial License 1.0.0**（Noncommercial Organizations 条款）。 |
| **公司 / 商业团队内部自用（总计 ≤ 20 人）**<br>*Internal company use up to 20 total users (≤ 20)* | **免费允许 (FREE)** | 适用 [`LICENSE`](LICENSE) 中的 **20 人以内公司内部免费附加许可（Small Internal Team Grant）**，无需联系授权。须**仅限内部自用**、不得对外售卖或向外部客户收费交付，且保留完整版权与协议文件。 |
| **公司 / 商业团队内部自用（超过 20 人）**<br>*Internal company use exceeding 20 total users (> 20)* | **需联系付费授权 (PAID LICENSE REQUIRED)** | 超出 20 人免费内部配额（按公司及其关联主体总使用人数计算），须事先联系 **OctoLab** 获取企业内部商业授权。 |
| **打包独立客户端对外售卖 / 订阅 / 买断**<br>*Selling, subscribing, or monetizing packaged standalone clients* | **需联系付费授权 (PAID LICENSE REQUIRED)** | 无论在官网、独立站、淘宝、闲鱼、应用商店或付费社群售卖由 `dsh-self` 生成的客户端（含「买课程/买硬件免费赠送打包客户端」等捆绑变现），均须事先取得 **OctoLab** 书面商业授权。 |
| **外包开发 / 商业定制交付甲方 / 商业平台集成 / 白标去署名**<br>*Paid agency/client delivery, commercial platform bundling, or white-labeling* | **需联系付费授权 (PAID LICENSE REQUIRED)** | 包括帮客户定制打包专属桌面客户端并收费交付、去除 `dsh-self` 版权声明白标发布，或将 `dsh-self` 能力集成进商业 SaaS/工具平台。 |

---

## 二、为什么生成出来的客户端也受本协议管辖？ / Why Packaged Clients Are Covered

`dsh-self` 并不是只输出纯配置文件的代码生成器。每一个通过 `dsh-self` 打包出来的独立桌面客户端安装包，内部都直接打包了 `OctoLab` 原创的**桌面壳运行时（`templates/desktop`）、自有产品壳与主题插件（`dsh-shell-product`、`dsh-theme-product`）、内置业务适配器（`@dsh-self/adapters`）、双槽自愈机制与 NSIS/平台封装脚本**。

因此，对外售卖、收费交付或超 20 人规模内部部署这些安装包，即构成对 `dsh-self` 原创受版权保护代码的商业分发与使用，需在相应商业场景前获取授权。

---

## 三、第三方依赖与社区插件边界 / Third-Party Dependencies & Community Plugins

1. **上游开源基础依赖**：DeepSeek Harness（MIT）、Electron（MIT）、sharp（Apache-2.0 / 动态链接 libvips LGPL-3.0-or-later）、docx-preview（Apache-2.0）、DOMPurify（Apache-2.0）等均保留其原始开源协议，详见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
2. **第三方社区 DSH 插件**：**OctoLab 商业授权仅覆盖 `dsh-self` 原创代码**。如果你在打包收费客户端时选入了第三方社区插件（如 `dsh-plugin-bidkit`、`dsh-design-studio`、`dsh-calendar` 等），你必须自行确认并遵守这些社区插件各自作者的许可协议。

---

## 四、如何申请商业授权 / How to Obtain a Commercial License

如果你计划在 **20 人以上的公司内部部署**，或使用 `dsh-self` **打包独立桌面客户端对外售卖、商业定制交付、白标发行**，请在使用前发送邮件至：

- **联系邮箱 / Email**: [`octoooo@octoooo.com`](mailto:octoooo@octoooo.com)
- **建议邮件标题 / Suggested Subject**: `[Commercial License] dsh-self - <您的公司/团队/产品名称>`
- **请简要说明 / Please Include**:
  1. 主体名称（公司名、工作室名或个人开发者信息）；
  2. 使用场景（例如：超过 20 人的公司内部部署、对外售卖独立桌面客户端、外包定制交付给甲方、或白标集成）；
  3. 预计规模（内部使用人数、计划发行的客户端产品数量或目标平台 Windows / macOS / Linux）；
  4. 是否需要配套技术支持或白标/商业签名流水线协助。

---

## 五、常见问题 / Licensing FAQ

### 1. 我们是一家 15 人的公司，用 `dsh-self` 打包了「内部标书工具」只给同事用，需要付费吗？
**不需要。** 只要贵司（含关联主体）总计使用人数**不超过 20 人（≤ 20 人）**，且该客户端**完全用于内部自用、不对外售卖或收费交付给外部客户**，即直接适用 `LICENSE` 中的 **20 人以内公司内部免费附加许可**，免费合法使用。未来团队使用人数超过 20 人时再联系 `octoooo@octoooo.com` 补办授权即可。

### 2. 我们只有 3 个人，但想用 `dsh-self` 包装一款行业专用客户端对外卖钱，可以走「20 人以内免费」吗？
**不可以。** 「不超过 20 人免费」**仅适用于公司内部自用**。只要涉及对外售卖客户端、按席位/订阅收费、付费下载、或作为有偿外包交付物卖给甲方客户，无论开发团队有几人，均属于对外商业化，必须先取得商业授权。

### 3. 我个人免费打包了一个工具发到 GitHub / 博客给大家免费下载，可以吗？
**完全可以。** 只要 100% 免费公开、不设付费下载/付费社群/强制打赏门槛，并在发布包或说明中保留 `LICENSE`、`COMMERCIAL-LICENSE.md`、`THIRD_PARTY_NOTICES.md` 及 `Required Notice:` 声明，即可免费分发。
