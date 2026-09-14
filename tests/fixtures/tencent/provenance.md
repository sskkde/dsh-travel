# tencent fixtures · provenance（M1 T3 / W2a）

| fixture | 录制 | 时间 | 脱敏 |
|---|---|---|---|
| poi-search-huanghelou.json | h5gw.map.qq.com `/ws/place/v1/search`（key=none 体验通道）真实响应 | 2026-09-02 | request_id 已剥离；无 key/token |
| poi-nearby-xihu-food.json | 同上（boundary=nearby 西湖 1km，keyword=美食）真实响应 | 2026-09-02 | request_id 已剥离 |
| weather-hangzhou.json | h5gw `/ws/weather/v1`（adcode=330106, type=future）真实响应 | 2026-09-02 | request_id 已剥离 |
| distance-matrix.json | h5gw `/ws/distance/v1/matrix`（mode=driving）真实响应 | 2026-09-02 | request_id 已剥离 |
| travel-guide-a2a.sse.txt | h5gw `/aichat/v1/a2a` AES SSE 真实事件流（21.8s 生成） | 2026-09-02 | 仅保留 `data:` 事件行；无 key |

复用提示（W3 fan-out）：POI 条目原始字段 `star_level/avg_price/opening_hours/location/ad_info`；
negative 值（avg_price=-1、opening_hours=null）由适配器按缺失清洗——fixture 保留原始形态供回归。