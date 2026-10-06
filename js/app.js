/* 北苑片区生存资源三维地图 — 前端主控 */
(function () {
  "use strict";

  if (typeof Cesium === "undefined" || typeof window.BEIYUAN === "undefined") {
    document.getElementById("loading").classList.add("hidden");
    document.getElementById("netwarn").classList.remove("hidden");
    return;
  }

  const D = window.BEIYUAN;
  const CATS = D.cats;
  const CAT_ORDER = ["supermarket", "medical", "hotel", "carrepair", "fuel", "hardware", "farm"];
  const DEG_M = 111320;

  const el = (id) => document.getElementById(id);
  const $ = (s) => document.querySelector(s);

  const state = {
    hidden: new Set(),
    heightScale: 1,
    minScore: 45,
    maxArea: 20000,
    coreOnly: true,
    showLabels: true,
    showLeaders: true,
    selectedCrop: "sweetpotato",
    selectedPlot: null,
    visibleCount: {}
  };

  const props = new WeakMap();   // Cesium.Entity -> 业务数据

  /* ==========================================================
   * 场景初始化
   * ========================================================== */
  const creditBox = document.createElement("div");
  creditBox.style.cssText = "position:absolute;right:110px;bottom:6px;z-index:9;" +
    "font-size:10px;color:#5b6472;opacity:.75;pointer-events:auto;max-width:52%;text-align:right;";
  el("map").appendChild(creditBox);

  const viewer = new Cesium.Viewer("cesiumContainer", {
    baseLayer: false,
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    animation: false, timeline: false, fullscreenButton: false, homeButton: false,
    navigationHelpButton: false, sceneModePicker: false, geocoder: false,
    baseLayerPicker: false, infoBox: false, selectionIndicator: false,
    creditContainer: creditBox,
    skyBox: false,            // 不要黑色星空
    skyAtmosphere: false,     // 不要地平线大气晕
    requestRenderMode: false
  });

  window.__viewer = viewer;      // 调试用
  const scene = viewer.scene;
  scene.screenSpaceCameraController.enableCollisionDetection = false;
  // ---- 纯白「高德风」背景：任何没有影像覆盖的地方都是白纸，不会发黑 ----
  scene.backgroundColor = Cesium.Color.fromCssColorString("#f2f2f0");
  scene.globe.baseColor = Cesium.Color.fromCssColorString("#ffffff");
  scene.globe.showGroundAtmosphere = false;
  scene.globe.enableLighting = false;
  scene.globe.depthTestAgainstTerrain = false;
  scene.globe.atmosphereBrightnessShift = 0;
  scene.fog.enabled = false;
  scene.highDynamicRange = false;
  scene.debugShowFramesPerSecond = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;

  /* ---------------- 底图 ---------------- */
  const GD_SUB = ["1", "2", "3", "4"];

  // 直连（默认，任何静态服务器都能用，但会受浏览器跨域/防盗链影响）
  const DIRECT_URL = {
    osm:       "https://tile.openstreetmap.de/{z}/{x}/{y}.png",
    esri:      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
  };
  // 走 server.py 的同源代理（无跨域限制 + 磁盘缓存 + 可离线）
  const PROXY_URL = {
    amap:      "/tiles/amap/{z}/{x}/{y}",
    amap_pure: "/tiles/amap_pure/{z}/{x}/{y}",
    amap_sat:  "/tiles/amap_sat/{z}/{x}/{y}",
    osm:       "/tiles/osm/{z}/{x}/{y}",
    esri:      "/tiles/esri/{z}/{x}/{y}"
  };

  const BASEMAPS = {
    osm:       { subdomains: [""],   max: 19, credit: "\u00a9 OpenStreetMap contributors" },
    esri:      { subdomains: [""],   max: 19, credit: "Esri World Imagery" }
  };

  // "direct" 还是 "proxy"，启动时探测 /health 决定
  let netMode = "direct";

  /* ---- 底图淡化（默认关闭：保持高德原色、原文字） ----
   * 用户需要时再开：只调透明度 + 轻度提亮，不动饱和度，文字与颜色尽量保真。 */
  state.dim = false;
  state.dimAlpha = 1.0;
  function applyDim() {
    if (!baseLayer) return;
    if (state.dim) {
      const a = state.dimAlpha;
      baseLayer.alpha = a;
      baseLayer.saturation = 0.85 + 0.15 * a;   // 保留原色，只轻微收敛
      baseLayer.brightness = 1.18 - 0.18 * a;
      baseLayer.contrast = 0.94 + 0.06 * a;
      baseLayer.gamma = 1.0;
    } else {
      baseLayer.alpha = 1;
      baseLayer.saturation = 1;
      baseLayer.brightness = 1;
      baseLayer.contrast = 1;
      baseLayer.gamma = 1;
    }
    scene.requestRender();
  }

  let baseLayer = null;
  function setBasemap(key) {
    const cfg = BASEMAPS[key] || BASEMAPS.osm;
    const url = (netMode === "proxy" ? PROXY_URL : DIRECT_URL)[key] || DIRECT_URL.osm;
    if (baseLayer) scene.imageryLayers.remove(baseLayer, true);
    try {
      baseLayer = scene.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({
        url: url,
        subdomains: netMode === "proxy" ? [""] : (cfg.subdomains || [""]),
        maximumLevel: cfg.max,
        credit: new Cesium.Credit(cfg.credit, false)
      }), 0);
      applyDim();
    } catch (e) {
      console.warn("底图切换失败", e);
    }
  }

  const currentBasemap = () => el("basemap").value || "osm";
  setBasemap("osm");
  el("basemap").value = "osm";
  el("basemap").addEventListener("change", (e) => setBasemap(e.target.value));

  // 探测本机 server.py：存在就切同源代理模式
  (async () => {
    return; // 静态版：无本地代理服务
    if (location.protocol === "file:") return;
    try {
      const r = await fetch("/health", { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      if (j && j.proxy) {
        netMode = "proxy";
        setBasemap(currentBasemap());
        const badge = el("netmode-badge");
        if (badge) { badge.textContent = "\u672c\u5730\u4ee3\u7406\u00b7\u53ef\u79bb\u7ebf"; badge.className = "badge proxy"; }
      }
    } catch (_) { /* 没有代理服务，保持直连 */ }
  })();

  /* ==========================================================
   * 图标
   * ========================================================== */
  const DPR = 3;

  function levelText(p) {
    if (p.lv) return p.lv + "\u5c42" + (p.hs ? "" : "\u00b7\u4f30");
    return "\u4e34\u8857\u70b9\u4f4d";
  }
  function coordCouple(p) {
    const la = (p.wy != null ? p.wy : p.y);
    const lo = (p.wx != null ? p.wx : p.x);
    return "N" + la.toFixed(5) + "  E" + lo.toFixed(5);
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }

  /* 高德风格 POI 卡片：左色块 + 名称 / 类别·楼层·楼号 / 经纬度 */
  function makeCard(p, withCoord) {
    const col = CATS[p.c].color;
    const l1 = (p.n && p.n !== "\u672a\u547d\u540d") ? p.n : CATS[p.c].zh + "\u70b9\u4f4d";
    const l2 = CATS[p.c].zh + " · " + levelText(p) + (p.hn ? " · " + p.hn : " · " + "\u697c\u53f7\u672a\u6807\u6ce8");
    const l3 = withCoord ? coordCouple(p) : "";

    const PADX = 11, PADY = 8, DOT = 22, GAP = 9, TIP = 8;
    const probe = document.createElement("canvas").getContext("2d");
    const FF = (w, s) => w + " " + s + "px 'PingFang SC','Microsoft YaHei',sans-serif";
    probe.font = FF(600, 15); const w1 = probe.measureText(l1).width;
    probe.font = FF(400, 12.5); const w2 = probe.measureText(l2).width;
    probe.font = FF(400, 11.5); const w3 = l3 ? probe.measureText(l3).width : 0;
    const tw = Math.max(w1, w2, w3);
    const W = Math.ceil(PADX * 2 + DOT + GAP + tw);
    const H = Math.ceil(PADY * 2 + 17 + 16 + (l3 ? 15 : 0) + TIP);

    const c = document.createElement("canvas");
    c.width = W * DPR; c.height = H * DPR;
    const g = c.getContext("2d");
    g.scale(DPR, DPR);
    g.clearRect(0, 0, W, H);

    const bodyH = H - TIP;
    g.save();
    g.shadowColor = "rgba(15,23,42,.28)"; g.shadowBlur = 6; g.shadowOffsetY = 2;
    g.fillStyle = "#ffffff"; roundRect(g, 0.5, 0.5, W - 1, bodyH - 1, 7); g.fill();
    g.restore();
    g.lineWidth = 2; g.strokeStyle = col;
    roundRect(g, 1, 1, W - 2, bodyH - 2, 7); g.stroke();

    g.beginPath();
    g.moveTo(W / 2 - 6, bodyH - 1); g.lineTo(W / 2, H); g.lineTo(W / 2 + 6, bodyH - 1);
    g.closePath();
    g.fillStyle = "#ffffff"; g.fill();
    g.lineWidth = 2; g.strokeStyle = col;
    g.beginPath();
    g.moveTo(W / 2 - 6, bodyH - 1); g.lineTo(W / 2, H); g.lineTo(W / 2 + 6, bodyH - 1);
    g.stroke();

    g.beginPath(); g.arc(PADX + DOT / 2, PADY + DOT / 2, DOT / 2, 0, Math.PI * 2);
    g.fillStyle = col; g.fill();
    g.font = "600 15px 'Segoe UI Symbol','PingFang SC',sans-serif";
    g.fillStyle = p.c === "hardware" ? "#334155" : "#ffffff";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(CATS[p.c].icon, PADX + DOT / 2, PADY + DOT / 2 + 1);

    const tx = PADX + DOT + GAP;
    g.textAlign = "left"; g.textBaseline = "alphabetic";
    g.font = FF(600, 15); g.fillStyle = "#111827";
    g.fillText(l1, tx, PADY + 14);
    g.font = FF(400, 12.5); g.fillStyle = "#6b7280";
    g.fillText(l2, tx, PADY + 14 + 16);
    if (l3) {
      g.font = FF(400, 11.5); g.fillStyle = "#9aa3b2";
      g.fillText(l3, tx, PADY + 14 + 16 + 15);
    }
    return { img: c.toDataURL(), w: W, h: H };
  }

  /* 远景：只剩一个小圆点 */
  function makeDot(color, icon, dark) {
    const S = 30, c = document.createElement("canvas");
    c.width = S * DPR; c.height = S * DPR;
    const g = c.getContext("2d");
    g.scale(DPR, DPR);
    g.beginPath(); g.arc(S / 2, S / 2, 11, 0, Math.PI * 2);
    g.lineWidth = 3.4; g.strokeStyle = "rgba(255,255,255,.98)"; g.stroke();
    g.fillStyle = color; g.fill();
    g.font = "600 12px 'Segoe UI Symbol','PingFang SC',sans-serif";
    g.fillStyle = dark ? "#334155" : "#ffffff";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(icon, S / 2, S / 2 + 0.5);
    return { img: c.toDataURL(), w: S, h: S };
  }

  const CARD = {};
  D.pois.forEach((p) => {
    CARD[p.i] = {
      near: makeCard(p, true),
      nearNo: makeCard(p, false),
      dot: makeDot(CATS[p.c].color, CATS[p.c].icon, p.c === "hardware")
    };
  });

  /* ==========================================================
   * 建筑体块
   * ========================================================== */
  const BUILD_COLOR = {
    residential: "#e6e3dc", apartments: "#e6e3dc", house: "#eae7e0",
    commercial: "#dfe3e9", retail: "#dfe3e9", office: "#dde2e9",
    industrial: "#e4e1d8", warehouse: "#e7e4dc",
    school: "#e6e4e8", hospital: "#e9e3e6", hotel: "#e0e5ec", yes: "#e5e2db"
  };
  const buildingEntities = [];
  function addBuildings() {
    D.buildings.forEach((b) => {
      const ring = [];
      for (let i = 0; i < b.r.length; i += 2) ring.push(b.r[i], b.r[i + 1]);
      if (ring.length < 8) return;
      let pos;
      try {
        pos = Cesium.Cartesian3.fromDegreesArray(ring);
      } catch (e) { return; }
      const col = Cesium.Color.fromCssColorString(BUILD_COLOR[b.t] || BUILD_COLOR.yes)
        .withAlpha(0.92);
      const ent = viewer.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(pos),
          extrudedHeight: b.h * state.heightScale,
          material: col,
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString("#a8a49b").withAlpha(0.75),
          outlineWidth: 1.2,
          perPositionHeight: false
        }
      });
      ent.__baseHeight = b.h;
      props.set(ent, { kind: "building", data: b });
      buildingEntities.push(ent);
    });
  }
  addBuildings();

  function applyHeightScale() {
    buildingEntities.forEach((ent) => {
      const v = ent.__baseHeight * state.heightScale;
      const eh = ent.polygon.extrudedHeight;
      if (eh && typeof eh.setValue === "function") eh.setValue(v);
      else ent.polygon.extrudedHeight = v;
    });
  }

  /* ==========================================================
   * 资源点（POI）
   * ========================================================== */
  const poiEntities = [];
  state.card = true;      // 是否显示信息卡
  state.coord = true;     // 卡片是否带经纬度
  const NEAR_M = 1500;    // 距离阈值：近→卡片，远→圆点

  function addPOIs() {
    D.pois.forEach((p) => {
      const card = CARD[p.i];
      const top = 46;
      const groundPos = Cesium.Cartesian3.fromDegrees(p.x, p.y, 0);
      const midPos = Cesium.Cartesian3.fromDegrees(p.x, p.y, top);

      const ent = viewer.entities.add({
        position: midPos,
        billboard: {
          image: card.dot.img, width: card.dot.w, height: card.dot.h,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          heightReference: Cesium.HeightReference.NONE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        },
        polyline: {
          positions: [groundPos, midPos],
          width: 2.2,
          material: new Cesium.ColorMaterialProperty(
            Cesium.Color.fromCssColorString(CATS[p.c].color).withAlpha(0.95))
        }
      });
      ent.__card = card;
      props.set(ent, { kind: "poi", data: p });
      poiEntities.push(ent);
    });
  }
  addPOIs();

  /* 卡片 / 圆点切换：由「信息卡」「经纬度」开关 + 相机距离决定 */
  function poiImage(ent, near) {
    if (!state.card || !near) return { img: ent.__card.dot.img, w: ent.__card.dot.w, h: ent.__card.dot.h, tip: 0 };
    const c = state.coord ? ent.__card.near : ent.__card.nearNo;
    return { img: c.img, w: c.w, h: c.h, tip: 1 };
  }

  let cardFar = false;
  function refreshPOIStyle() {
    poiEntities.forEach((ent) => {
      const s = poiImage(ent, !cardFar);
      const bb = ent.billboard;
      if (bb.image.getValue ? bb.image.getValue() !== s.img : bb.image !== s.img) {
        bb.image = s.img;
        bb.width = s.w;
        bb.height = s.h;
      }
      ent.polyline.show = state.leader !== false;
    });
  }

  function updateCardScale() {
    const h = viewer.camera.positionCartographic.height;
    const far = h > NEAR_M * 1.6;
    if (far !== cardFar) {
      cardFar = far;
      refreshPOIStyle();
    }
  }
  viewer.camera.changed.addEventListener(() => {
    if (window.__cardRAF) return;
    window.__cardRAF = requestAnimationFrame(() => { window.__cardRAF = null; updateCardScale(); });
  });
  refreshPOIStyle();

  /* ==========================================================
   * 可种植地块
   * ========================================================== */
  const plotEntities = [];
  function addPlots() {
    D.plots.forEach((p, idx) => {
      const ring = [];
      for (let i = 0; i < p.r.length; i += 2) ring.push(p.r[i], p.r[i + 1]);
      if (ring.length < 8) return;
      let pos;
      try { pos = Cesium.Cartesian3.fromDegreesArray(ring); } catch (e) { return; }
      const n = ring.length / 2;
      let sx = 0, sy = 0;
      for (let i = 0; i < n; i++) { sx += ring[i * 2]; sy += ring[i * 2 + 1]; }
      const cx = sx / n, cy = sy / n;

      const alpha = 0.10 + 0.22 * (p.s / 100);
      const ent = viewer.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(pos),
          height: 2.0,
          material: Cesium.Color.fromCssColorString(CATS.farm.color).withAlpha(alpha),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString(CATS.farm.color).withAlpha(0.95),
          outlineWidth: 2
        },
        position: Cesium.Cartesian3.fromDegrees(cx, cy, 2),
        label: {
          text: `${fmtArea(p.a)} · ${p.s}`,
          font: "600 11px 'PingFang SC','Microsoft YaHei',sans-serif",
          fillColor: Cesium.Color.fromCssColorString("#ffffff"),
          outlineColor: Cesium.Color.fromCssColorString("#3b0764"),
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3400),
          translucencyByDistance: new Cesium.NearFarScalar(400, 1.0, 3400, 0.2)
        }
      });
      props.set(ent, { kind: "plot", data: p, idx });
      plotEntities.push(ent);
    });
  }
  addPlots();

  /* ==========================================================
   * 工具函数
   * ========================================================== */
  function fmtArea(a) {
    if (a >= 10000) return (a / 10000).toFixed(2) + " 万㎡";
    return Math.round(a) + " ㎡";
  }
  function fmtNum(n) {
    return n >= 10000 ? Math.round(n).toLocaleString("zh-CN") : String(Math.round(n * 10) / 10);
  }
  function distMeters(lon1, lat1, lon2, lat2) {
    const mly = DEG_M, mlx = DEG_M * Math.cos((lat1 * Math.PI) / 180);
    return Math.hypot((lon1 - lon2) * mlx, (lat1 - lat2) * mly);
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  window.__show = renderDetail;  // 调试 / 自动化测试入口
  window.__pick = (ent) => { const o = props.get(ent); if (o) { renderDetail(o.kind, o.data); flyToEntity(ent); } };

  /* ==========================================================
   * 图例与统计
   * ========================================================== */
  function buildLegend() {
    const box = el("legend");
    box.innerHTML = "";
    CAT_ORDER.forEach((k) => {
      const c = CATS[k];
      const n = D.pois.filter((p) => p.c === k).length;
      const div = document.createElement("div");
      div.className = "lg";
      div.dataset.cat = k;
      div.innerHTML =
        `<span class="sw" style="background:${c.color}"></span>
         <span class="tx"><span class="t1">${c.zh}</span><span class="t2">${CAT_DESC[k]}</span></span>
         <span class="ct">${n}</span>`;
      div.addEventListener("click", () => {
        if (state.hidden.has(k)) state.hidden.delete(k); else state.hidden.add(k);
        refreshVisibility();
      });
      box.appendChild(div);
    });
  }

  const CAT_DESC = {
    supermarket: "主食 / 罐头 / 瓶装水集中点",
    medical: "医院、门诊、药房与急救耗材",
    hotel: "高层楼宇据点：出入口可控、结构可靠",
    carrepair: "工具、铅酸电池、耗材与零配件",
    fuel: "燃油补给；断电后不再可用",
    hardware: "钢筋水泥模板、板材、五金工具",
    farm: "地缘推算的连片空地 + 农资种子渠道"
  };

  function refreshVisibility() {
    poiEntities.forEach((ent) => {
      const p = props.get(ent).data;
      ent.show = !state.hidden.has(p.c);
    });
    plotEntities.forEach((ent) => {
      const p = props.get(ent).data;
      const ok = (!state.hidden.has("farm")) &&
                 p.s >= state.minScore &&
                 p.a <= state.maxArea &&
                 (!state.coreOnly || p.nb <= 200);
      ent.show = ok;
    });
    document.querySelectorAll("#legend .lg").forEach((d) => {
      d.classList.toggle("off", state.hidden.has(d.dataset.cat));
    });
    updateStats();
  }

  function updateStats() {
    const counts = {};
    CAT_ORDER.forEach((k) => (counts[k] = 0));
    poiEntities.forEach((e) => {
      if (!e.show) return;
      const p = props.get(e).data;
      if (p.core) counts[p.c]++;
    });
    state.visibleCount = counts;

    const visiblePlots = plotEntities.filter((e) => e.show);
    const area = visiblePlots.reduce((s, e) => s + props.get(e).data.a, 0);
    const top = Math.max(0, ...visiblePlots.map((e) => props.get(e).data.s));

    let html = "";
    CAT_ORDER.forEach((k) => {
      html += `<div class="row"><i style="background:${CATS[k].color}"></i>${CATS[k].zh}<b>${counts[k]}</b></div>`;
    });
    html += `<div class="row"><i style="background:${CATS.farm.color}"></i>候选种植地块<b>${visiblePlots.length}</b></div>`;
    html += `<div class="row"><i style="background:#c9d2de"></i>建筑体块<b>${buildingEntities.length}</b></div>`;
    html += `<div class="note">可视地块合计 ${fmtArea(area)}，最高评分 ${top.toFixed(0)}。
              OSM 在城区的 POI 覆盖并不完整，加油站等类别已向北苑外围做半径扩展搜索。</div>`;
    el("stats").innerHTML = html;
    el("stat-count").textContent = D.pois.length + " 个点位";
  }

  /* ==========================================================
   * 详情面板
   * ========================================================== */
  const SUB_ZH = {
    hotel: "酒店宾馆", structure: "高层/综合体", care: "养老照护机构",
    tower: "写字楼 / 大厦", apartment: "公寓住宅",
    hospital: "医院", clinic: "门诊 / 卫生服务机构", pharma: "药房", vet: "宠物医疗",
    retail: "零售超市", wholesale: "批发市场",
    greenspace: "绿地 / 空地", seed: "农资 / 花卉 / 种子"
  };

  function renderDetail(kind, data) {
    const box = el("detail");
    if (kind === "plot") return renderPlot(box, data);
    if (kind === "building") return renderBuilding(box, data);
    return renderPOI(box, data);
  }

  function levelFull(p) {
    if (!p.lv) return "临街点位（OSM 未挂到楼体，按单层底商理解）";
    const src = p.hs ? "OSM 标注层数" : "按建筑高度 ÷3.1m 估算";
    if (p.bh) return `约 ${p.lv} 层（楼体 ${p.bh} m，${src}）`;
    return `约 ${p.lv} 层（${src}）`;
  }
  function llRows(p) {
    const la = (p.wy != null ? p.wy : p.y);
    const lo = (p.wx != null ? p.wx : p.x);
    const rows = [];
    rows.push(["WGS-84 经纬度", `N ${la.toFixed(6)}°　E ${lo.toFixed(6)}°`]);
    rows.push(["GCJ-02 经纬度", `${p.y.toFixed(6)}, ${p.x.toFixed(6)}（高德/腾讯底图口径）`]);
    return rows;
  }

  /* GCJ-02 → WGS-84（迭代反解，供建筑详情显示 GPS 原始坐标） */
  window.__gcj2wgs = (function () {
    const A = 6378245.0, EE = 0.00669342162296594323;
    function tl(x, y) {
      let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
      r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2 / 3;
      r += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2 / 3;
      r += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2 / 3;
      return r;
    }
    function tt(x, y) {
      let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
      r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2 / 3;
      r += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2 / 3;
      r += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320.0 * Math.sin(y * Math.PI / 30.0)) * 2 / 3;
      return r;
    }
    function gcjOf(lon, lat) {
      const dx = tl(lon - 105.0, lat - 35.0), dy = tt(lon - 105.0, lat - 35.0);
      const rad = lat / 180.0 * Math.PI;
      const magic = 1 - EE * Math.sin(rad) * Math.sin(rad);
      const sq = Math.sqrt(magic);
      const dlat = (dy * 180.0) / ((A * (1 - EE)) / (magic * sq) * Math.PI);
      const dlon = (dx * 180.0) / (A / sq * Math.cos(rad) * Math.PI);
      return [lon + dlon, lat + dlat];
    }
    return function (lon, lat) {
      let wx = lon, wy = lat;
      for (let i = 0; i < 3; i++) {
        const g = gcjOf(wx, wy);
        wx += lon - g[0];
        wy += lat - g[1];
      }
      return [wx, wy];
    };
  })();

  function renderPOI(box, p) {
    const c = CATS[p.c];
    const rows = [];
    rows.push(["类别", `${c.zh}${p.sub ? " · " + (SUB_ZH[p.sub] || p.sub) : ""}`]);
    rows.push(["楼层", levelFull(p)]);
    rows.push(["楼号 / 门牌", p.hn ? esc(p.hn) : "OSM 未标注（需现场核实）"]);
    rows.push(...llRows(p));
    if (p.bid) rows.push(["依托建筑", `OSM way ${p.bid}`]);
    const t = p.tags || {};
    if (t["opening_hours"]) rows.push(["营业时间", esc(t["opening_hours"])]);
    if (t.phone) rows.push(["电话", esc(t.phone)]);
    if (t["addr:street"]) rows.push(["所在街道", esc(t["addr:street"])]);
    rows.push(["区域", p.core ? "北苑核心区" : "外围扩展区"]);

    let html = `<h3>${esc(p.n)}</h3><span class="badge" style="background:${c.color};
      color:${p.c === "hardware" ? "#333" : "#fff"}">${c.zh}</span>
      <table>${rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join("")}</table>`;

    const adv = ADVICE[p.c] || "";
    if (adv) html += `<div class="adv">${adv(p)}</div>`;

    const extra = Object.keys(t).filter((k) => k !== "name" && k !== "name:en");
    if (extra.length) {
      html += `<div class="tags">OSM 原始标签：${extra.slice(0, 8).map((k) => esc(k + "=" + t[k])).join(" · ")}</div>`;
    }
    box.className = "detail";
    box.innerHTML = html;
  }

  function renderBuilding(box, b) {
    const levels = b.lv || Math.max(1, Math.round(b.h / 3.1));
    const cx0 = b.r[0], cy0 = b.r[1];
    const wgs = window.__gcj2wgs ? window.__gcj2wgs(cx0, cy0) : null;
    const html = `<h3>建筑体块 · ${b.hn ? esc(b.hn) : "#" + b.id}</h3>
      <span class="badge" style="background:#8a94a4">建筑</span>
      <table>
        <tr><td>用途</td><td>${esc(b.t)}</td></tr>
        <tr><td>楼层</td><td>${levels} 层${b.hs ? "（OSM 标注）" : "（高度 ÷3.1m 估算）"}</td></tr>
        <tr><td>占地</td><td>${fmtArea(b.a)}</td></tr>
        <tr><td>高度</td><td>${b.h} m${b.e ? "（按类型估算，非实测）" : "（OSM 标注）"}</td></tr>
        <tr><td>楼号</td><td>${b.hn ? esc(b.hn) : "OSM 未标注"}</td></tr>
        <tr><td>GCJ-02</td><td>${cy0.toFixed(6)}, ${cx0.toFixed(6)}</td></tr>
        ${wgs ? `<tr><td>WGS-84</td><td>N ${wgs[1].toFixed(6)}°　E ${wgs[0].toFixed(6)}°</td></tr>` : ""}
      </table>
      <div class="adv">${b.e
        ? "该楼 OSM 未提供层数标注，高度是按建筑类型与占地规模推算的量级参考，不要拿它去做工程判断。"
        : "该楼高度取自 OSM 的 height / building:levels 标注。"}</div>`;
    box.className = "detail";
    box.innerHTML = html;
  }

  function renderPlot(box, p) {
    state.selectedPlot = p;
    const rows = [
      ["地块面积", fmtArea(p.a)],
      ["可耕作面积", fmtArea(p.a * window.CROP_META.usableRatio) + "（扣除垄沟步道 30%）"],
      ["采光评分", `${p.sun} / 100`],
      ["通风评分", `${p.wind} / 100`],
      ["后勤半径", `离最近建筑 ${p.nb} m（评分 ${p.reach}）`],
      ["南侧遮挡", p.tall > 0 ? `90 m 内有 ${p.tall} m 高建筑` : "90 m 内无明显遮挡"],
      ["土地性质", p.g ? "OSM 已标注绿地 / 农田" : "由空地几何推算，性质未标注"],
      ["中心 WGS-84", p.wy != null ? `N ${p.wy.toFixed(6)}°　E ${p.wx.toFixed(6)}°` : "—"],
      ["综合评分", `${p.s} / 100`]
    ];
    let html = `<h3>候选种植地块</h3>
      <span class="badge" style="background:${CATS.farm.color}">可种植地</span>
      <table>${rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join("")}</table>
      <div class="adv warn">${p.g ? "" : "这块地在 OSM 里没有绿地/农田标注，只是「未建筑、非道路」的连片空地。" +
        "实际可能是荒地、苗圃、停车场或已开工工地，落地前必须现场确认权属与用途。"}</div>`;
    html += `<div class="cropbox" id="cropbox"></div>`;
    box.className = "detail";
    box.innerHTML = html;
    renderCropBox();
  }

  function renderCropBox() {
    const host = el("cropbox");
    if (!host) return;
    const p = state.selectedPlot;
    if (!p) return;
    const M = window.CROP_META;
    const usable = p.a * M.usableRatio;

    const list = window.CROPS.slice().sort((a, b) => {
      const ea = a.kcalKg * a.kgM2 / a.days, eb = b.kcalKg * b.kgM2 / b.days;
      return eb - ea;
    });
    const cur = list.find((x) => x.k === state.selectedCrop) || list[0];
    state.selectedCrop = cur.k;

    const seasonsAct = Math.max(1, Math.min(cur.seasons, Math.floor(M.frostFreeDays / cur.days)));
    const kcalSeason = usable * cur.kgM2 * cur.kcalKg;
    const kcalYear = kcalSeason * seasonsAct;
    const kcalDay = kcalYear / 365;
    const adults = kcalDay / M.kcalPerAdult;
    const surv = kcalDay / M.kcalMinimal;

    const rows = list.map((c) => {
      const eff = (c.kcalKg * c.kgM2 / c.days);
      return `<tr data-k="${c.k}" class="${c.k === cur.k ? "sel" : ""}">
        <td class="pri">${"★".repeat(c.pri)}</td>
        <td>${c.zh}</td>
        <td class="n">${c.days}</td>
        <td class="n">${Math.round(c.kcalKg * c.kgM2)}</td>
        <td class="n">${eff.toFixed(1)}</td>
        <td class="n">${c.store}</td>
        <td class="n">${c.hardy}</td>
      </tr>`;
    }).join("");

    host.innerHTML = `
      <div class="ch">作物产能测算 — 点击行切换作物</div>
      <div class="out">
        现选 <b>${cur.zh}</b>（${cur.days} 天成熟，${cur.kcalKg} kcal/kg，${cur.kgM2} kg/㎡·季）<br>
        这块 ${fmtArea(p.a)} 实际可种 <b>${fmtArea(usable)}</b>，华北无霜期 ${M.frostFreeDays} 天内可排
        <b>${seasonsAct}</b> 茬。<br>
        每季产出 <b>${fmtNum(usable * cur.kgM2)} kg</b> ≈ <b>${fmtNum(kcalSeason)} kcal</b>；
        全年 <b>${fmtNum(kcalYear)} kcal</b>，折合日均 <b>${fmtNum(kcalDay)} kcal</b>。<br>
        按 ${M.kcalPerAdult} kcal/人·天计，可维持 <b>${adults.toFixed(1)} 人</b>；
        按 ${M.kcalMinimal} kcal 的最低生存线计，可维持 <b>${surv.toFixed(1)} 人</b>。
        <div style="margin-top:8px;padding-top:7px;border-top:1px dashed #e3e6eb">
          <b>要点：</b>${cur.tip}<br>
          <b>种子：</b>${cur.seedNote}
        </div>
      </div>
      <table class="croptbl">
        <thead><tr>
          <th>优先</th><th>作物</th><th class="n">天数</th>
          <th class="n">kcal/㎡·季</th><th class="n">kcal/㎡·日</th>
          <th class="n">耐储月</th><th class="n">耐粗放</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="adv" style="margin-top:8px">
        单一作物会有营养缺口：粮食提供热量、豆类与花生补蛋白与油脂、叶菜与豆芽补维生素 C。
        实操上按「<b>${Math.round(usable * 0.6)} ㎡ 主粮 + ${Math.round(usable * 0.25)} ㎡ 豆类油料 +
        ${Math.round(usable * 0.15)} ㎡ 速生叶菜</b>」分配比较稳。
        上述数字是理论单产中值，第一年实际收成按 5 折预估更现实——土壤改良与经验都需要时间。
      </div>`;

    host.querySelectorAll("tbody tr").forEach((tr) => {
      tr.addEventListener("click", () => {
        state.selectedCrop = tr.dataset.k;
        renderCropBox();
      });
    });
  }

  /* ==========================================================
   * 类别建议文案
   * ========================================================== */
  const ADVICE = {
    supermarket: () => `
      <b>搬运优先级：</b>瓶装水与净水片 → 米面油盐 → 罐头 / 压缩饼干 → 多维元素片 →
      电池 / 充电宝 / 手电 → 垃圾袋与保鲜膜 → 打火机与固体酒精 → 绳索胶带。<br>
      <b>注意：</b>冷链商品断电后 24–48 小时失效，先吃这部分。大型超市断电后自动门常落锁，
      后勤通道与收货平台口通常是更实际的进入点。`,

    medical: (p) => `
      <b>${p.sub === "pharma" ? "药房" : p.sub === "clinic" ? "门诊 / 卫生服务站" : "医院"}可获取：</b>
      口服补液盐、碘伏与酒精棉片、无菌敷料与弹力绷带、止血带、抗生素软膏、抗过敏与退烧止痛药、止泻药、一次性手套。<br>
      <b>注意：</b>院外处方类（胰岛素、抗凝药、吸入剂）需要转到医院途径，且这类物资要靠提前储备。
      医院目标显著、人流密集，通常只在事态稳定后才值得靠近；它的价值在于备用发电机与急诊耗材。`,

    hotel: (p) => `
      <b>作为长期据点的判断要点：</b><br>
      1. 楼层：优先 <b>8–15 层</b>。低于 3 层易受积水与噪声影响；高于 20 层一旦断电，电梯停用，
      搬水上下楼的成本会压垮日常。<br>
      2. 竖向交通：至少要有 <b>两条独立疏散楼梯</b>，一部电梯的塔楼风险集中。<br>
      3. 结构与围护：混凝土剪力墙优于玻璃幕墙（抗风、抗抛掷物、保温）。<br>
      4. 水：楼顶水箱或高层供水系统是长期生存的关键，确认有无二次供水设备。<br>
      5. 朝向与户型：南北通透便于自然通风，减少长期密闭下的湿气与呼吸道问题。<br>
      <b>提示：</b>这里的「易守难攻」按建筑安全口径理解——出入口可控、结构可靠、可上锁，
      用于避洪、避风、避极端天气，而不是战术用途。${p.bh ? `<br>当前目标估算高度 ${p.bh} m。` : ""}`,

    carrepair: () => `
      <b>能拿到什么：</b>12 V 铅酸蓄电池（配逆变器可做照明与通信电源）、千斤顶与整套扳手、
      扎带卡箍铁丝、机油润滑油（也可作防锈与简易照明燃料）、废旧轮胎（做密封垫与缓冲）、
      火花塞皮带滤清器、玻璃水与除锈剂。<br>
      <b>注意：</b>修理厂多为临街单层，卷帘门是主要的防护结构；地沟容易积水，不适合做仓储。`,

    fuel: () => `
      <b>现实预期要压低：</b>加油站的泵靠电驱动，大规模断电后无法取油，地下储油罐个人无法抽取。
      真正可取的通常是站内便利店物资。<br>
      <b>储备要点：</b>汽油氧化后 3–6 个月性能下降，加稳定剂可延到 12–18 个月；
      柴油 6–12 个月且容易滋生微生物，需干燥密封并定期轮换倒罐。<br>
      <b>安全：</b>燃油与发电机必须在室外通风处使用，室内运行发电机会因 CO 中毒致命，
      这是断电气象下最常见的死亡原因。`,

    hardware: () => `
      <b>采购清单：</b>铁丝与捆扎带 → 膨胀螺栓与自攻螺丝 → 木工板与防水卷材 →
      硅酮密封胶 → PVC 管与接头 → 手推车与水桶 → 硅酸盐水泥、中粗砂、碎石。<br>
      <b>注意：</b>袋装水泥开封后 3–6 个月受潮失效，必须离地垫高、密封存放。
      真正的瓶颈往往不是结构材料而是紧固件与密封件，这些东西体积小吃水浅，值得大量囤。`,

    farm: () => `
      <b>用这块地的顺序：</b>先测土（很多城市空地是建筑回填土，含砖渣且贫瘠）→
      堆肥改土 2–3 个月 → 先种耐粗放的薯类豆类，第二批再上精细叶菜。<br>
      <b>水：</b>按华北蒸发量估算，旱季每平方米每周约需 15–25 L，一万平方米就是每周上百吨，
      取水与蓄水的工程量通常比整地更大。<br>
      <b>种子：</b>优先选常规种（非 F1 杂交），才能自留；杂交玉米第二代会严重分离退化。`
  };

  /* ==========================================================
   * 交互
   * ========================================================== */
  function flyToEntity(ent) {
    const o = props.get(ent);
    let radius = 420;
    if (o.kind === "poi") radius = 300;
    else if (o.kind === "plot") radius = Math.max(260, Math.sqrt(o.data.a) * 2.2);
    else radius = Math.max(320, Math.sqrt(o.data.a) * 2.6);
    viewer.flyTo(ent, {
      offset: new Cesium.HeadingPitchRange(
        viewer.camera.heading, Cesium.Math.toRadians(-42), radius),
      duration: 1.2
    });
  }

  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction((movement) => {
    const picked = scene.pick(movement.position);
    if (Cesium.defined(picked) && picked.id && props.has(picked.id)) {
      const o = props.get(picked.id);
      renderDetail(o.kind, o.data);
      if (o.kind !== "building") flyToEntity(picked.id);
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  handler.setInputAction((movement) => {
    const cart = viewer.camera.pickEllipsoid(movement.endPosition, scene.globe.ellipsoid);
    if (cart) {
      const cg = Cesium.Cartographic.fromCartesian(cart);
      const lon = Cesium.Math.toDegrees(cg.longitude), lat = Cesium.Math.toDegrees(cg.latitude);
      el("hud-ll").textContent = `${lon.toFixed(5)}, ${lat.toFixed(5)}`;
      const d = distMeters(lon, lat, 116.4074, 39.9042);
      el("hud-dist").textContent = `${(d / 1000).toFixed(1)} km`;
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  /* 比例尺：对地面做两点反算，比按相机高度推算可靠 */
  const SCALE_PX = 60;
  function metersPerPixel() {
    const w = scene.drawingBufferWidth, h = scene.drawingBufferHeight;
    const cx = Math.floor(w / 2);
    const cy = Math.floor(h - 18);
    const a = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(cx - SCALE_PX / 2, cy), scene.globe.ellipsoid);
    const b = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(cx + SCALE_PX / 2, cy), scene.globe.ellipsoid);
    if (!a || !b) return 0;
    return Cesium.Cartesian3.distance(a, b) / SCALE_PX;
  }
  function niceRound(v) {
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    const step = n >= 5 ? 5 : n >= 2 ? 2 : 1;
    return step * p;
  }

  let hudTick = 0;
  viewer.scene.postRender.addEventListener(() => {
    const ch = viewer.camera.positionCartographic.height;
    el("hud-alt").textContent = ch > 1000 ? (ch / 1000).toFixed(2) + " km" : Math.round(ch) + " m";
    if (++hudTick % 8 !== 0) return;
    const mpp = metersPerPixel();
    if (!mpp) return;
    const barMeters = niceRound(mpp * SCALE_PX);
    const px = Math.round(barMeters / mpp);
    el("scale-text").innerHTML =
      `<span class="bar" style="width:${Math.min(160, px)}px"></span>` +
      `${barMeters >= 1000 ? (barMeters / 1000).toFixed(1) + " km" : Math.round(barMeters) + " m"}`;
  });

  /* ---------------- 侧栏控件 ---------------- */
  el("tg-dim").addEventListener("change", (e) => {
    state.dim = e.target.checked;
    if (state.dim && state.dimAlpha > 0.92) {   // 勾选时给一个能看出效果的默认值
      state.dimAlpha = 0.7;
      el("r-dim").value = "0.7";
      el("v-dim").textContent = "70%";
    }
    applyDim();
  });
  el("r-dim").addEventListener("input", (e) => {
    state.dimAlpha = parseFloat(e.target.value);
    el("v-dim").textContent = Math.round(state.dimAlpha * 100) + "%";
    applyDim();
  });
  el("tg-build").addEventListener("change", (e) => {
    state.buildings = e.target.checked;
    buildingEntities.forEach((ent) => (ent.show = e.target.checked));
  });
  el("tg-label").addEventListener("change", (e) => {
    state.card = e.target.checked;
    plotEntities.forEach((ent) => { if (ent.label) ent.label.show = e.target.checked; });
    refreshPOIStyle();
  });
  el("tg-coord").addEventListener("change", (e) => {
    state.coord = e.target.checked;
    refreshPOIStyle();
  });
  el("tg-leader").addEventListener("change", (e) => {
    state.leader = e.target.checked;
    refreshPOIStyle();
  });
  el("tg-core").addEventListener("change", (e) => {
    state.coreOnly = e.target.checked;
    refreshVisibility();
  });
  el("r-height").addEventListener("input", (e) => {
    state.heightScale = parseFloat(e.target.value);
    el("v-height").textContent = state.heightScale.toFixed(1) + "×";
    applyHeightScale();
  });
  el("r-score").addEventListener("input", (e) => {
    state.minScore = parseFloat(e.target.value);
    el("v-score").textContent = state.minScore;
    refreshVisibility();
  });
  el("r-area").addEventListener("input", (e) => {
    state.maxArea = parseFloat(e.target.value);
    el("v-area").textContent = state.maxArea >= 10000
      ? (state.maxArea / 10000).toFixed(state.maxArea % 10000 ? 1 : 0) + " 万㎡"
      : Math.round(state.maxArea) + " ㎡";
    refreshVisibility();
  });
  el("detail-close").addEventListener("click", () => {
    el("detail-panel").classList.toggle("collapsed");
    el("detail-close").textContent = el("detail-panel").classList.contains("collapsed") ? "▾" : "×";
  });
  el("btn-reset").addEventListener("click", () => setView("tilt"));
  el("viewmode").addEventListener("change", (e) => setView(e.target.value));

  /* ---------------- 视角 ---------------- */
  const CENTER = {
    lon: (D.meta.center && D.meta.center[0]) || 116.4272,
    lat: (D.meta.center && D.meta.center[1]) || 40.0334
  };
  function setView(mode) {
    const center = Cesium.Cartesian3.fromDegrees(CENTER.lon, CENTER.lat, 10);
    const cfg = {
      tilt:     { radius: 1150, pitch: -42, heading: 28 },
      top:      { radius: 2400, pitch: -89, heading: 0 },
      street:   { radius:  520, pitch: -26, heading: 15 },
      district: { radius: 5200, pitch: -55, heading: 22 }
    }[mode] || { radius: 1150, pitch: -42, heading: 28 };
    viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(center, cfg.radius), {
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(cfg.heading), Cesium.Math.toRadians(cfg.pitch), cfg.radius),
      duration: 1.5
    });
  }

    /* ---------------- 搜索 ---------------- */
  const sInput = el("search"), sList = el("search-list");
  sInput.addEventListener("input", () => {
    const q = sInput.value.trim().toLowerCase();
    if (!q) { sList.classList.remove("on"); sList.innerHTML = ""; return; }
    const hits = D.pois.filter((p) =>
      (p.n || "").toLowerCase().includes(q) ||
      CATS[p.c].zh.includes(q) ||
      (p.sub && (SUB_ZH[p.sub] || "").includes(q))
    ).slice(0, 12);
    if (!hits.length) {
      sList.innerHTML = `<div style="color:#8b93a1">没有匹配的点位</div>`;
    } else {
      sList.innerHTML = hits.map((p) =>
        `<div data-k="${p.n}"><i style="background:${CATS[p.c].color}"></i>${esc(p.n)}
         <small>${CATS[p.c].zh}</small></div>`).join("");
      sList.querySelectorAll("div[data-k]").forEach((d) => {
        d.addEventListener("click", () => {
          const p = hits.find((x) => x.n === d.dataset.k);
          sList.classList.remove("on");
          sInput.value = p.n;
          viewer.camera.flyToBoundingSphere(
            new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(p.x, p.y, 20), 340),
            { offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-42), 340), duration: 1.3 });
          renderDetail("poi", p);
        });
      });
    }
    sList.classList.add("on");
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".searchbox")) sList.classList.remove("on");
  });

  /* ---------------- 数据来源说明 ---------------- */
  el("credits-list").innerHTML = [
    `<b>底图</b>：© OpenStreetMap contributors / Esri World Imagery（公网静态版，未使用高德瓦片）；三维楼块为 OSM 数据自建。`,
    `<b>建筑轮廓、道路、POI</b>：OpenStreetMap contributors，经 Overpass API 抓取，ODbL 1.0；已整体从 WGS84 转为 GCJ-02 以对齐高德底图。`,
    `<b>建筑高度</b>：${D.buildings.filter((b) => b.e === 0).length} 栋取自 OSM 标注，其余按建筑类型与占地规模估算，仅供视觉参考。`,
    `<b>可种植地块</b>：在 ${(D.meta.bbox[2] - D.meta.bbox[0]).toFixed(3)}° × ${(D.meta.bbox[3] - D.meta.bbox[1]).toFixed(3)}° 窗口内做 20 m 栅格化，
     剔除建筑占地、道路及其缓冲后做连通聚类，再按周边建筑的遮挡角算采光与通风评分。<b>这是几何推算，不是土地性质认定。</b>`,
    `<b>OSM 城区 POI 覆盖不完整</b>：加油站、汽修、建材等类别已在北苑外围做扩展搜索补充，外围点位在面板中标注。<b>任何一次实地决策前都要现场核实。</b>`,
    `<b>图层分工</b>：灰白底图 + 米白楼块都是背景，<b>只有带色描边的卡片和紫色地块是本图自己标记的结论</b>；
     底图默认 100%＝高德原色原文字不处理；需要时勾「淡化底图」再拖滑块（只降透明度、保留颜色与文字）。`,
    `<b>卡片上的三行</b>：名称 ／ 类别·楼层·楼号 ／ 经纬度。
     楼层优先取 OSM 的 building:levels，缺失时按建筑高度 ÷3.1 m 估算（标「·估」）；
     楼号取 addr:housenumber 或楼栋标注 ${D.pois.filter((p) => p.hn).length}/${D.pois.length} 个点位有，其余是 OSM 未标注住宅门牌，需现场核实；
     经纬度默认给 WGS-84（GPS 原始值），详情面板里并列给出 GCJ-02（高德口径）。`,
    `<b>作物产能</b>：华北露天条件下的常用单产中值，属测算参考值；首年实际收成按五折预估更现实。`
  ].map((s) => `<li>${s}</li>`).join("");

  el("brand-sub").textContent =
    `DEMO — ${D.meta.area} · ${D.buildings.length} 栋建筑 / ${D.pois.length} 个资源点 / ${D.plots.length} 块候选地块`;

  /* ---------------- 启动 ---------------- */
  if (location.protocol === "file:") {
    const w = document.getElementById("file-warning");
    if (w) w.style.display = "block";
  }
  buildLegend();
  refreshVisibility();
  setView("tilt");
  el("viewmode").value = "tilt";
  el("loading").classList.add("hidden");
})();
