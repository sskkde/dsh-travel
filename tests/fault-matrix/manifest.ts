/**
 * 全渠道故障矩阵 manifest（M3.6 / W6；roadmap M3.6、m3-execution-plan T7）。
 *
 * 行清单真源 = src/client/fields.ts 的 CHANNEL_FIELDS（28 channel / FR-3~7 五组，
 * 与设置卡渲染顺序一致）。本模块**程序化派生** 28 行并在**模块加载时**断言
 * UI 字段表与 manifest 1:1（无漏行/无重复/无多余）——fields.ts 行数变化而
 * 本表未同步时，模块加载即抛错（构建期拦截，防矩阵与设置页漂移）。
 *
 * 每行声明（T7 任务规格）：
 * - channelId / group / keyId：继承自 CHANNEL_FIELDS；
 * - owningTool：产出该渠道结果的 travel_* 工具；
 * - fallback：主渠道失败后的降级/人工渠道声明（design §2.1 降级矩阵行内化）；
 * - applicableFaults：四类注入（missing-key/service-down/timeout/rate-limit）中该行适用者；
 *   notApplicableFaults：不适用的注入类型 + 诚实原因（逐行登记，不留空泛「不适用」）；
 * - controlledEmpty：该渠道「合法空结果」口径（搜索无结果/索引抽样空等非故障形态）。
 *
 * 特别登记（m3-execution-plan Non-goals / M2 CLOSURE 口径）：
 * - xhsCloak：无 license + 默认 off + 无运行时消费方 → off/not-applicable，
 *   不执行任何注入（CloakBrowser 休眠合规口径）；
 * - cityDidi：上游服务态故障（transit 无 result）与代码故障分离记录，
 *   上游态 case 记 service-state，不计入代码故障分母。
 */
import { CHANNEL_FIELDS, type ChannelGroup } from '../../src/client/fields.js'

/** 四类注入（T7 规格：a 缺 key/渠道关；b 服务停；c 超时；d 限流）。 */
export const FAULT_KINDS = ['missing-key', 'service-down', 'timeout', 'rate-limit'] as const
export type FaultKind = (typeof FAULT_KINDS)[number]

/** 产出渠道结果的 travel_* 工具（owningTool 全集）。 */
export const OWNING_TOOLS = [
  'travel_research_destination',
  'travel_research_transport',
  'travel_research_advice',
  'travel_build_itinerary',
  'travel_render_page',
] as const
export type OwningTool = (typeof OWNING_TOOLS)[number]

/** 每行主数据的业务注解（fields.ts 只给 id/group/keyId，语义在此补全）。 */
interface ChannelFaultMeta {
  owningTool: OwningTool
  /** 主失败后的降级/人工渠道声明（design §2.1）。 */
  fallback: string
  /** 适用的注入类型。 */
  applicableFaults: readonly FaultKind[]
  /** 不适用类型 + 诚实原因。 */
  notApplicableFaults: Readonly<Partial<Record<FaultKind, string>>>
  /** 「合法空结果」口径（非故障形态）。 */
  controlledEmpty: string
  /** 特殊语义标注（runner 据此走专门分支）。 */
  special?: 'cloak-off' | 'didi-service-state' | 'adapter-only'
  /** 备注（链位语义等）。 */
  note?: string
}

/** 矩阵行（= CHANNEL_FIELDS 字段 + 业务注解）。 */
export interface FaultMatrixRow {
  channelId: string
  group: ChannelGroup
  keyId?: string
  owningTool: OwningTool
  fallback: string
  applicableFaults: readonly FaultKind[]
  notApplicableFaults: Readonly<Partial<Record<FaultKind, string>>>
  controlledEmpty: string
  special?: 'cloak-off' | 'didi-service-state' | 'adapter-only'
  note?: string
}

/**
 * 逐行业务注解（按 channelId 索引；与 fields.ts 1:1 由 assertManifestCovers
 * 模块加载时校验）。
 *
 * applicability 判定依据（实测代码面）：
 * - missing-key：行有 keyId → 抑制该 key（ADR-12 settings→credentials→env 链
 *   同一判定路径）；零 key 行的 missing-key 由 channel-off 形态承担（T7 注入 a
 *   =「KeyResolutionEnv missing / channel off」同一类，纯内存 env 面），记入
 *   applicableFaults 并在 note 注明形态；代码未接 settings 门的行如实 N/A；
 * - service-down：适配器传输面（fetchFn/httpCall/hostSearch/MCP ping）可注入；
 * - timeout：适配器内建超时闸（AmapAdapter/WendaoAdapter/OpenMeteo/MCP 客户端
 *   Promise.race/AbortSignal）或编排级预算截断（fanout budget）可注入；无任何
 *   超时闸且不在 fanout 预算内的行（如腾讯 httpCall 20s 闸超出单测预算、render
 *   无网络面）如实 N/A；
 * - rate-limit：域级令牌桶治理面仅挂 xhs（XhsAdapter acquireRate）与 cloak
 *   （休眠不演练）——其余适配器未接 acquireRate 调用面，限流注入不适用。
 */
const CHANNEL_FAULT_META: Record<string, ChannelFaultMeta> = {
  // ── FR-3 社媒情报（travel_research_destination 七渠道 + L1 升级轨） ──
  xhsMcp: {
    owningTool: 'travel_research_destination',
    fallback: 'xhsFallback（L0+L0.5 自动降级链，channels.ts ④）→ 三层/平台情报；人工：手动浏览小红书检索',
    applicableFaults: ['missing-key', 'service-down', 'timeout', 'rate-limit'],
    notApplicableFaults: {},
    controlledEmpty: '登录态检索与降级链均无条目属非故障：degraded 记账（会话失效/容器不可用）后由其他渠道承接',
    note: 'missing-key 走 channel-off 形态（零 key 渠道，仅 settings 开关门）；rate-limit=XhsAdapter 域级令牌桶（xiaohongshu.com）',
  },
  xhsFallback: {
    owningTool: 'travel_research_destination',
    fallback: '腾讯 POI（结构化补充）+ 三层 L0 + platformIntel；最终标注缺失（NFR-2）',
    applicableFaults: ['missing-key', 'service-down', 'timeout'],
    notApplicableFaults: { 'rate-limit': 'SearchAdapter 未接 acquireRate 治理面（令牌桶仅 xhs/cloak 挂接）' },
    controlledEmpty: 'SERP 对 site:xiaohongshu.com 无命中属索引抽样空（L0 尽力而为，非故障）',
    note: 'missing-key 走 channel-off 形态（零 key 渠道）；hostSearch 故障经 l0HitsFor 容错 → EMPTY 记账',
  },
  xhsCloak: {
    owningTool: 'travel_research_destination',
    fallback: '无消费方（休眠位）；小红书主路径由 xhsMcp/xhsFallback 承接',
    applicableFaults: [],
    notApplicableFaults: {
      'missing-key': '无 license（settings/credentials/env 均未命中）+ 默认 off + 无运行时消费方——M2 CLOSURE 休眠口径，off/not-applicable 登记，不执行注入',
      'service-down': '同上：增强分支仅挂接位（CLOAK_HOOK_BLOCKED_REASON），无 live 消费方',
      timeout: '同上：无 live 调用面',
      'rate-limit': '同上：CloakBrowser 适配器虽挂 acquireRate，但渠道休眠不演练',
    },
    controlledEmpty: '不适用（渠道 off，无产出语义）',
    special: 'cloak-off',
  },
  douyin: {
    owningTool: 'travel_research_destination',
    fallback: 'tier2（知乎）+ tier3 L0 兜底 + platformIntel；条目标注「仅标题摘要」（JS-SPA 限制）',
    applicableFaults: ['missing-key', 'service-down', 'timeout'],
    notApplicableFaults: { 'rate-limit': 'SocialAdapter 未接 acquireRate 治理面' },
    controlledEmpty: 'L0 抽样无命中属索引抽样空（仅标题摘要形态本身非故障）',
    note: 'missing-key 走 channel-off 形态（零 key 渠道）',
  },
  tier2: {
    owningTool: 'travel_research_destination',
    fallback: 'tier3（微博/贴吧/快手 L0）+ platformIntel；标注缺失',
    applicableFaults: ['missing-key', 'service-down', 'timeout'],
    notApplicableFaults: { 'rate-limit': 'SearchAdapter 未接 acquireRate 治理面' },
    controlledEmpty: 'site:zhihu.com 无命中属索引抽样空',
    note: 'missing-key 走 channel-off 形态（零 key 渠道）',
  },
  tier3: {
    owningTool: 'travel_research_destination',
    fallback: 'platformIntel（web 泛搜索）；最终标注缺失',
    applicableFaults: ['missing-key', 'service-down', 'timeout'],
    notApplicableFaults: { 'rate-limit': 'SocialAdapter 未接 acquireRate 治理面' },
    controlledEmpty: '三层平台 L0 全部无结果属索引抽样空（tier3Channel 以 degraded 明细记账，人话原因）',
    note: 'missing-key 走 channel-off 形态（零 key 渠道）',
  },
  socialL1: {
    owningTool: 'travel_research_destination',
    fallback: '三层 L0 兜底（socialL1Channel 全空 → EMPTY，fanout 记账，L0 兜底渠道在清单后位）',
    applicableFaults: ['missing-key', 'service-down', 'timeout'],
    notApplicableFaults: { 'rate-limit': 'PlaywrightSocialAdapter 接受桶注入但未挂 acquireRate 调用面' },
    controlledEmpty: '三平台登录墙/空结果属平台态（源级 degraded 走 L0 兜底语义，非故障）',
    note: 'missing-key 走 channel-off 形态；socialDepth=L0 用户配置亦属 off 形态（run 内记账）',
  },
  tencentPoi: {
    owningTool: 'travel_research_destination',
    fallback: '高德 POI（基础搜索配额，amapWebservice）→ 最终标注缺失；限流时提示配置正式 TMAP key',
    applicableFaults: ['missing-key', 'service-down', 'timeout'],
    notApplicableFaults: { 'rate-limit': 'TencentMapAdapter 未接 acquireRate 治理面（零 key 体验通道）' },
    controlledEmpty: 'tip/warning 类无 POI 种子属口径内空（POI_SEEDS 种子表：该两类由 L0 渠道覆盖）',
    note: 'missing-key 走 channel-off 形态（零 key h5gw 体验通道；正式 key 缺失不阻塞可用性）',
  },
  platformIntel: {
    owningTool: 'travel_research_destination',
    fallback: '最底层 L0 兜底：无渠道可降 → 条目标注缺失 + degraded 记账 + adviceSearch/LLM 常识兜底承接建议面',
    applicableFaults: ['missing-key', 'service-down', 'timeout'],
    notApplicableFaults: { 'rate-limit': 'SearchAdapter 未接 acquireRate 治理面' },
    controlledEmpty: '泛搜索无命中属索引抽样空（EMPTY 记账，不阻塞七类其余类别）',
    note: 'missing-key 走 channel-off 形态（零 key 渠道）',
  },
  // ── FR-4 交通（travel_research_transport） ──
  rail12306: {
    owningTool: 'travel_research_transport',
    fallback: 'intercity 互备链 wendao→flyai（零 key search-train）→ L0 搜索结构化；最终「班次请以 12306 为准」+ 官方链接（www.12306.cn）',
    applicableFaults: ['missing-key', 'service-down', 'timeout'],
    notApplicableFaults: { 'rate-limit': 'Rail12306Adapter（MCP）未接域级令牌桶' },
    controlledEmpty: '预售期外/无票查询返回空属上游业务口径（记账「班次请以 12306 官方为准」，非代码故障）',
    note: 'missing-key 走 channel-off 形态（免 key MCP；开关门=channelEnabled("rail12306")）；服务停=ping 失败',
  },
  railWendao: {
    owningTool: 'travel_research_transport',
    fallback: 'flyai search-train（零 key 试用档）→ L0 搜索结构化；全空 → 人工比价 + 官方渠道链接',
    applicableFaults: ['missing-key', 'service-down', 'timeout'],
    notApplicableFaults: { 'rate-limit': 'WendaoAdapter 未接 acquireRate 治理面' },
    controlledEmpty: '问道咨询无结构化车次属源口径（chain trySource 记 EMPTY 后落 flyai/搜索位）',
  },
  railFlyai: {
    owningTool: 'travel_research_transport',
    fallback: 'L0 搜索结构化（intercity 第三档）→ 全空 → 人工比价 + 官方渠道链接',
    applicableFaults: ['missing-key', 'service-down', 'timeout'],
    notApplicableFaults: { 'rate-limit': 'FlyaiAdapter（CLI 二进制）未接 acquireRate 治理面' },
    controlledEmpty: 'flyai 试用档无结果属源口径（chain 记 EMPTY 后落搜索位）',
    note: '链位在 wendao 之后：flyai 段故障 case 需上游 wendao 段同故障（链语义）；缺 key=零 key 试用档照常（设计语义），missing-key case 断言「缺 key 不阻塞 + wendao 缺 key 休眠记账」',
  },
  flightWendao: {
    owningTool: 'travel_research_transport',
    fallback: 'flyai queryFlights → L0 搜索结构化三档；全空 → 人工比价 + 官方渠道链接',
    applicableFaults: ['missing-key', 'service-down', 'timeout'],
    notApplicableFaults: { 'rate-limit': 'WendaoAdapter 未接 acquireRate 治理面' },
    controlledEmpty: '问道航班咨询无结构化结果属源口径（chain 记 EMPTY 后落 flyai/搜索位）',
  },
  flightFlyai: {
    owningTool: 'travel_research_transport',
    fallback: 'L0 搜索结构化（三档降级链末位）→ 全空 → 明示人工比价 + 官方购票渠道链接',
    applicableFaults: ['missing-key', 'service-down', 'timeout'],
    notApplicableFaults: { 'rate-limit': 'FlyaiAdapter（CLI 二进制）未接 acquireRate 治理面' },
    controlledEmpty: '试用档无结果属源口径（chain 记 EMPTY 后落搜索位）',
    note: '同 railFlyai：链位在 wendao 之后，故障 case 需上游同故障（链语义）',
  },
  busConsult: {
    owningTool: 'travel_research_transport',
    fallback: 'L0 搜索（P1 结构化兜底）；全空 → 标注缺失',
    applicableFaults: ['missing-key', 'service-down', 'timeout'],
    notApplicableFaults: { 'rate-limit': 'WendaoAdapter 未接 acquireRate 治理面' },
    controlledEmpty: '汽车票咨询级无结构化数据源属未确认清单口径（§13；记账不阻塞）',
    note: 'missing-key 抑制 wendao key（busConsult 咨询级经问道模板，无独立 key）',
  },
  cityAmap: {
    owningTool: 'travel_research_transport',
    fallback: '滴滴渠道二（maps_direction_transit 公共交通选项）→ L0「机场/车站→市区交通」→ 标注缺失',
    applicableFaults: ['missing-key', 'service-down', 'timeout'],
    notApplicableFaults: { 'rate-limit': 'AmapAdapter 未接 acquireRate 治理面（配额走 QuotaCounter 预算面）' },
    controlledEmpty: '高德无市内公共交通方案属业务口径（EMPTY「高德无市内公共交通方案」记账）',
    note: 'missing-key=抑制 amapWebservice（available() 门：degraded「Key 未配置（amapWebservice）」）',
  },
  cityDidi: {
    owningTool: 'travel_research_transport',
    fallback: '高德渠道一单方案（滴滴失败/未配 → 自动降级高德）→ L0 兜底',
    applicableFaults: ['missing-key', 'service-down', 'timeout'],
    notApplicableFaults: { 'rate-limit': 'DidiAdapter（MCP）未接域级令牌桶' },
    controlledEmpty: '上游 maps_direction_transit 无 result（滴滴服务态）属上游口径：degraded「滴滴 MCP 无市内公共交通方案」，service-state 单独登记不计代码失败',
    special: 'didi-service-state',
    note: 'missing-key=抑制 didi key（available() 门：degraded「Key 未配置（DIDI_MCP_KEY）」）',
  },
  // ── FR-5 出行建议（travel_research_advice） ──
  weatherAmap: {
    owningTool: 'travel_research_advice',
    fallback: '腾讯 weather（零 key，5 天）→ Open-Meteo（免 key，16 天）→ 气候概况（历史同期 L0）',
    applicableFaults: ['missing-key', 'service-down', 'timeout'],
    notApplicableFaults: { 'rate-limit': 'AmapAdapter 未接 acquireRate 治理面' },
    controlledEmpty: '行程日期超出预报窗口属口径内空（beyondForecastWindow:true + 气候概况标注）',
    note: 'missing-key=抑制 amapWebservice；坐标解析经腾讯 POI 链兜底',
  },
  weatherTencent: {
    owningTool: 'travel_research_advice',
    fallback: 'Open-Meteo（免 key）→ 气候概况；高德在位时由链首覆盖逐日数据',
    applicableFaults: ['missing-key', 'service-down'],
    notApplicableFaults: {
      timeout: 'TencentMapAdapter 内建超时闸=20s（DEFAULT_TIMEOUT_MS/AbortSignal），超出单测预算；advice 工具无编排级预算截断——超时降级链与 service-down 同构（catch→degraded→Open-Meteo 兜底），由 service-down case 覆盖',
      'rate-limit': 'TencentMapAdapter 未接 acquireRate 治理面',
    },
    controlledEmpty: '缺少目的地坐标（上游链全败）→ 记账「腾讯天气（location 模式）无法查询」人话原因',
    note: 'missing-key 走 channel-off 形态（零 key 渠道）',
  },
  weatherOpenMeteo: {
    owningTool: 'travel_research_advice',
    fallback: '气候概况（历史同期 L0 抽取温度区间）→「以临近预报为准」人话标注',
    applicableFaults: ['missing-key', 'service-down', 'timeout'],
    notApplicableFaults: { 'rate-limit': 'OpenMeteoAdapter 未接 acquireRate 治理面' },
    controlledEmpty: '行程日期超 16 天预报窗口 → 服务端净空 + beyondForecastWindow 标注（非故障）',
    note: 'missing-key 走 channel-off 形态（免 key 渠道）；超时闸=适配器 withTimeout（timeoutMs 可注入）',
  },
  adviceSearch: {
    owningTool: 'travel_research_advice',
    fallback: 'LLM 按槽位画像生成（标注「未经检索验证」）——模板穿衣/物品清单（≥10 项）不受影响',
    applicableFaults: ['service-down'],
    notApplicableFaults: {
      'missing-key': '零 key 渠道且 runResearchAdvice 未接 adviceSearch settings 门（search 注入即启用）——channel-off 语义无消费位，如实登记',
      timeout: 'hostSearch 注入面无内建超时闸且 advice 工具无编排级预算（挂起注入将无限等待）；超时降级链与 service-down 同构（catch→degraded→模板清单兜底），由 service-down case 覆盖',
      'rate-limit': 'SearchAdapter 未接 acquireRate 治理面',
    },
    controlledEmpty: 'L0 注意事项搜索无命中属索引抽样空（EMPTY「L0 注意事项搜索无命中」记账）',
  },
  // ── FR-6 动线/攻略（travel_build_itinerary） ──
  routeCheckAmap: {
    owningTool: 'travel_build_itinerary',
    fallback: '腾讯 distance_matrix（零 key）→ 直线距离估算（标注「直线估算」语义）——动线校验不中断',
    applicableFaults: ['missing-key', 'service-down', 'timeout'],
    notApplicableFaults: { 'rate-limit': 'AmapAdapter 未接 acquireRate 治理面' },
    controlledEmpty: 'stops 无坐标的日期跳过该校验（warnings 明示「动线距离校验跳过该日」）',
    note: 'missing-key=抑制 amapWebservice（provider available 门）',
  },
  routeCheckTencent: {
    owningTool: 'travel_build_itinerary',
    fallback: '直线距离估算（Haversine，GCJ-02 平面近似，标注估算语义）',
    applicableFaults: ['missing-key', 'service-down'],
    notApplicableFaults: {
      timeout: 'runRouteCheck 无编排级预算；TencentMapAdapter 内建 20s 闸超出单测预算——超时降级链与 service-down 同构（catch→degraded→estimate 兜底），由 service-down case 覆盖',
      'rate-limit': 'TencentMapAdapter 未接 acquireRate 治理面',
    },
    controlledEmpty: '不适用（估算兜底永可行；无合法空形态）',
    note: 'missing-key 走 channel-off 形态（零 key 体验通道；channelGate("routeCheckTencent")）；链位在 amap 之后——故障 case 需 amap 同故障（链语义，同 railFlyai）',
  },
  travelGuideTencent: {
    owningTool: 'travel_build_itinerary',
    fallback: '主模型 draft 生成（travel_guide 为可选结构化素材位，缺失不阻塞 build）',
    applicableFaults: ['service-down'],
    notApplicableFaults: {
      'missing-key': '零 key（h5gw/A2A）且 tools 未接线该素材位——channel-off 语义无消费位',
      timeout: 'A2A SSE 长连接超时闸（A2A_TIMEOUT_MS）为分钟级，超出单测预算；adapter 层以 service-down 演练错误归一化',
      'rate-limit': 'TencentMapAdapter 未接 acquireRate 治理面',
    },
    controlledEmpty: 'A2A 无 plan_day 事件 → EMPTY「travel_guide 未产出行程」（源口径）',
    special: 'adapter-only',
    note: '设计口径=「可作结构化行程素材补充」（可选）；当前 tools 未消费，故障演练在适配器面（travelGuide 端点故障 → EngineError 归一化，无裸异常）',
  },
  // ── FR-7 可视化（travel_render_page） ──
  mapAmap: {
    owningTool: 'travel_render_page',
    fallback: 'Leaflet+OSM 自动降级 + warning 明示降级原因（缺 key/jscode/开关停用）',
    applicableFaults: ['missing-key'],
    notApplicableFaults: {
      'service-down': 'JS API loader/瓦片加载为浏览器运行时面，服务端渲染路径无该渠道网络调用可注入',
      timeout: '同上：地图加载在浏览器面',
      'rate-limit': '渲染路径无 HTTP 出站调用（key 仅注入页面配置）',
    },
    controlledEmpty: '不适用（渲染必有页面产出；无合法空形态）',
    note: 'missing-key=抑制 amapJsapi/amapJscode（selectMapProvider 双 key 门）；service-down 形态=jscode 安全代理（B 模式）能力缺失，见 notApplicableFaults.service-down 说明',
  },
  mapLeaflet: {
    owningTool: 'travel_render_page',
    fallback: '列表视图（无地图，页面标注）；amap 可用时改用 amap+warning（selectMapProvider 显式 leaflet 分支）',
    applicableFaults: ['missing-key'],
    notApplicableFaults: {
      'service-down': 'OSM 瓦片不可用为浏览器运行时面（设计降级=列表视图标注），服务端无法注入',
      timeout: '同上：瓦片加载在浏览器面',
      'rate-limit': '渲染路径无 HTTP 调用',
    },
    controlledEmpty: '不适用（Leaflet 为零 key 兜底渲染，必有页面产出）',
    note: 'missing-key 走 channel-off 形态：mapLeaflet off + amap 就绪 → 改用 amap+warning（off 语义双向降级）',
  },
  deliveryRoute: {
    owningTool: 'travel_render_page',
    fallback: '本地文件路径交付（rendered:true + filePath 不变）；页面写盘亦败 → rendered:false + 人话原因 + 重试入口（§9.3-6）',
    applicableFaults: ['service-down'],
    notApplicableFaults: {
      'missing-key': '零 key 渠道且 render 路由注册未接 settings 门（注册无条件执行）——channel-off 语义无消费位，如实登记',
      timeout: '路由注册为本地 registrar 调用（无网络面）',
      'rate-limit': '无 HTTP 出站调用',
    },
    controlledEmpty: '不适用（本地文件通道承接后仍有完整产出）',
    note: 'service-down=registrar.register 注入抛错 → 断言路由注册失败后本地文件交付仍可用（design §2.1 FR-7 页面交付降级链）',
  },
  deliveryFile: {
    owningTool: 'travel_render_page',
    fallback: 'webserver prefix 路由在线访问；双通道均败 → rendered:false + 人话原因 + 重试入口（§9.3-6）',
    applicableFaults: ['service-down'],
    notApplicableFaults: {
      'missing-key': '零 key 渠道且本地写盘未接 settings 门',
      timeout: '本地 fs 写盘（无网络面）',
      'rate-limit': '无 HTTP 出站调用',
    },
    controlledEmpty: '不适用（写盘失败属故障态，走 rendered:false + 重试入口）',
    note: 'service-down=store 计划目录只读注入（runner 自有 tmpdir 内真实 fs 面，finally 复原权限）→ 断言无裸异常 + 结构化失败 + 重试入口',
  },
}

/**
 * 派生 28 行并在模块加载时断言与 CHANNEL_FIELDS 1:1：
 * - CHANNEL_FIELDS 每个字段都有业务注解（无漏行）；
 * - 注解表每个键都在 CHANNEL_FIELDS 中（无多余行）；
 * - 每组行数与 fields.ts 组员一致（组内无重复）；
 * - 总数恰为 28。
 * 任何不同步（fields.ts 增删行而本表未同步）→ **模块加载即抛错**。
 */
function assertManifestCoversChannelFields(): void {
  const fieldIds = CHANNEL_FIELDS.map((def) => def.id)
  const metaIds = Object.keys(CHANNEL_FAULT_META)
  const missing = fieldIds.filter((id) => !metaIds.includes(id))
  if (missing.length > 0) {
    throw new Error(
      `[fault-matrix] fields.ts 新增渠道未同步 manifest：${missing.join(', ')}`
      + '——请在 tests/fault-matrix/manifest.ts CHANNEL_FAULT_META 补齐该行业务注解',
    )
  }
  const extra = metaIds.filter((id) => !fieldIds.includes(id))
  if (extra.length > 0) {
    throw new Error(
      `[fault-matrix] manifest 注解含 fields.ts 不存在的渠道（已删除/改名未同步）：${extra.join(', ')}`
      + '——请清理 tests/fault-matrix/manifest.ts CHANNEL_FAULT_META 多余表项',
    )
  }
  const dup = fieldIds.filter((id, i) => fieldIds.indexOf(id) !== i)
  if (dup.length > 0) {
    throw new Error(`[fault-matrix] fields.ts 渠道 id 重复：${dup.join(', ')}`)
  }
  const EXPECTED_TOTAL = 28
  if (fieldIds.length !== EXPECTED_TOTAL) {
    throw new Error(
      `[fault-matrix] CHANNEL_FIELDS 行数=${fieldIds.length}，期望 ${EXPECTED_TOTAL}（28 channel/5 FR 组）`
      + '——行数变化须同步复核 fault-matrix manifest 与报告分母',
    )
  }
}

/** 派生后的矩阵行（顺序=fields.ts 渲染顺序；模块加载时完成 1:1 校验）。 */
export const FAULT_MATRIX_ROWS: readonly FaultMatrixRow[] = (() => {
  assertManifestCoversChannelFields()
  return CHANNEL_FIELDS.map((def) => {
    const meta = CHANNEL_FAULT_META[def.id]
    if (meta === undefined) {
      // 防御（assertManifestCoversChannelFields 已拦；此处收窄类型用）
      throw new Error(`[fault-matrix] 渠道 ${def.id} 缺业务注解`)
    }
    // 一致性再断言：keyId 与 applicability 口径互洽（有 keyId 的行若走 channel-off
    // 形态须在 note 说明；无 keyId 的行不得声明 missing-key 为「key 抑制」形态）。
    if (def.keyId === undefined && meta.note?.includes('missing-key=抑制') === true) {
      throw new Error(`[fault-matrix] ${def.id} 无 keyId 却声明 key 抑制形态`)
    }
    return {
      channelId: def.id,
      group: def.group,
      ...(def.keyId !== undefined ? { keyId: def.keyId } : {}),
      ...meta,
    }
  })
})()

/** 按 FR 组分组的行视图（报告/分组演练用）。 */
export function rowsByGroup(): Record<ChannelGroup, readonly FaultMatrixRow[]> {
  const out: Record<ChannelGroup, readonly FaultMatrixRow[]> = { fr3: [], fr4: [], fr5: [], fr6: [], fr7: [] }
  for (const row of FAULT_MATRIX_ROWS) out[row.group].push(row)
  return out
}

/** 每组「主渠道」（该工具的主力产出渠道；「全部主渠道失败」演练的操作集）。 */
export const GROUP_PRIMARY_CHANNELS: Record<ChannelGroup, readonly string[]> = {
  fr3: ['xhsMcp', 'xhsFallback', 'douyin', 'tier2', 'tier3', 'tencentPoi', 'platformIntel'],
  fr4: ['rail12306', 'railWendao', 'railFlyai', 'flightWendao', 'flightFlyai', 'busConsult', 'cityAmap', 'cityDidi'],
  fr5: ['weatherAmap', 'weatherTencent', 'weatherOpenMeteo', 'adviceSearch'],
  fr6: ['routeCheckAmap', 'routeCheckTencent'],
  fr7: ['mapAmap', 'mapLeaflet', 'deliveryRoute', 'deliveryFile'],
}

/** CloakBrowser license 在位判定（只查存在性，零值读取/零回显）。 */
export function cloakLicensePresent(): boolean {
  if (typeof process.env['CLOAKBROWSER_LICENSE_KEY'] === 'string'
    && process.env['CLOAKBROWSER_LICENSE_KEY'].trim().length > 0) {
    return true
  }
  // vitest 环境无宿主 settings 服务（travelSettingsSnapshot()=undefined），
  // credentials 位不可达——进程 env 是矩阵可观测的唯一 license 面。
  return false
}
