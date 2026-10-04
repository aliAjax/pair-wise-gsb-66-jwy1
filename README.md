# 铁路轨道几何缺陷整治与复测平台

基于Vue3、Vuetify、Pinia、Vue Router、Apollo Client、GraphQL、Vite和TypeScript的独立前端工程，使用Canvas绘制里程图。业务数据本地持久化。

## 功能

- 区段、里程、轨距、高低、方向和三角坑检测数据。
- Canvas里程分布、超限点定位、缺陷三角标记和缩放。
- 缺陷筛选、批量派工、工区责任和重复缺陷关联。
- 打磨、捣固、更换、垫板调整等整治记录，复测轮次与关闭校验。
- 正式限速与临时限速冲突联查，区段版本递增。
- 离线补录说明、完整审计和整治报告导出。

端口为`18466`。

```bash
npm install
npm run build
npm run dev
```
