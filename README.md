# 北苑生存资源三维图（公网静态版）

纯静态站点，可直接托管到 GitHub Pages / EdgeOne Pages / 任意静态服务器。

- 底图：OSM 标准图 / Esri 卫星影像（均为 WGS-84 瓦片）；OSM 社区镜像被限流时会自动降级到官方瓦片源
- 数据：OpenStreetMap contributors（Overpass API，ODbL 1.0），共 163 个资源点 / 357 栋建筑 / 82 条道路 / 45 个桥隧卡点 / 84 块候选地块
- 坐标：数据文件存的是 GCJ-02，页面会按底图基准自动换算（高德系用 GCJ-02，OSM/Esri 用 WGS-84）
- 步行距离：OSRM 步行路网实测（routing.openstreetmap.de），取不到时退回「直线×1.35」并在界面标注「直线」
- 三维引擎：Cesium 1.115 已随仓库本地化（cesium/ 目录），无需外网依赖
- 带本地代理（高德底图 + 瓦片磁盘缓存 + 离线可用）的版本不在此仓库，需另仓维护

本地预览：在本目录执行 `python -m http.server 8000`，打开 http://localhost:8000
