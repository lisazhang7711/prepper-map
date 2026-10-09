# 北苑生存资源地图（公网静态版）

纯静态站点，可直接托管到 GitHub Pages / EdgeOne Pages / 任意静态服务器。

- 底图：高德地图 JS API（GCJ-02），需要联网 + 一个 Web 端（JS API）Key
- 数据：OpenStreetMap contributors（Overpass API，ODbL 1.0），共 163 个资源点 / 357 栋建筑 / 82 条道路 / 45 个桥隧卡点 / 84 块候选地块
- 坐标：数据文件存的就是 GCJ-02，与高德底图一致，无需换算
- 步行距离：OSRM 步行路网实测（routing.openstreetmap.de），取不到时退回「直线×1.35」并在界面标注「直线」
- 点位默认折叠：只显示一枚单字彩色图标，点击才展开该点信息卡，再点收起

本地预览：在本目录执行 `python -m http.server 8000`，打开 http://localhost:8000
