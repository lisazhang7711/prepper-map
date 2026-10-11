/* 北苑片区生存资源三维地图 — 前端主控 */
(function () {
  "use strict";

  /* 没有 Key / 加载不到高德 JS API 时，给一个能自己填 Key 的入口 */
  function bindKeyPanel() {
    const panel = document.getElementById("keypanel");
    const input = document.getElementById("key-input");
    const save = document.getElementById("key-save");
    const cancel = document.getElementById("key-cancel");
    if (!panel) return;
    if (cancel) cancel.addEventListener("click", () => panel.classList.add("hidden"));
    if (save && input) {
      const doSave = () => {
        const v = (input.value || "").trim();
        if (!v) { input.focus(); return; }
        try { localStorage.setItem("amap_key", v); } catch (e) {}
        location.reload();
      };
      save.addEventListener("click", doSave);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSave(); });
    }
  }

  if (typeof window.BEIYUAN === "undefined") {
    document.getElementById("loading").classList.add("hidden");
    document.getElementById("netwarn").classList.remove("hidden");
    return;
  }
  if (typeof AMap === "undefined" || !AMap.Map) {
    document.getElementById("loading").classList.add("hidden");
    document.getElementById("netwarn").classList.remove("hidden");
    document.getElementById("keypanel").classList.remove("hidden");
    bindKeyPanel();
    return;
  }

  const D = window.BEIYUAN;
  const CATS = D.cats;
  const CAT_ORDER = D.cat_order ||
    ["supermarket", "medical", "hotel", "carrepair", "fuel", "hardware", "farm"];
  /* 「可种地」这一类在新旧数据里键名不同，统一取 */
  const PLOT_KEY = CATS.plot ? "plot" : "farm";
  const PLOT_COLOR = (CATS[PLOT_KEY] || { color: "#8B5CF6" }).color;
  const PLOT_NEAR_M = 50;     // 「宅边地块」：离最近建筑 50 m 以内
  const DEG_M = 111320;

  /* ==========================================================
   * 坐标基准
   * 底图是高德（GCJ-02），数据本身也是 GCJ-02 —— 两者一致，不需要任何换算。
   * ========================================================== */
  /* 手动位置校正
   * OSM 是众包数据，点位偏几十米很常见（有的落在楼后、有的落在路口对面）。
   * 用户可以在详情面板里「微调」把图标拖到实地位置，校正值只存本机 localStorage，
   * 不改原始数据；点「恢复原始位置」即可撤销。 */
  const FIX_KEY = "pm_fix";
  const FIX = (function () {
    try { return JSON.parse(localStorage.getItem(FIX_KEY) || "{}"); } catch (e) { return {}; }
  })();
  function saveFix() {
    try { localStorage.setItem(FIX_KEY, JSON.stringify(FIX)); } catch (e) {}
  }
  function distM(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b.y - a.y) * r, dLng = (b.x - a.x) * r;
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(a.y * r) * Math.cos(b.y * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function llOf(p) {
    const f = p && p.i ? FIX[p.i] : null;
    return f ? [f.x, f.y] : [p.x, p.y];
  }
  function ringOf(r) { return r; }

  /* 极简提示条（本文件原本没有 toast，微调反馈要用） */
  function toast(msg) {
    let t = document.getElementById("pm-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "pm-toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = "show";
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.className = ""; }, 2600);
  }

  /* 基地（HUD「光标到基地」的参照点） */
  const BASE_GCJ = (function () {
    const b = D.meta && D.meta.base, c = D.meta && D.meta.center;
    const v = (b && b.length === 2) ? b : ((c && c.length === 2) ? c : null);
    return v ? [v[0], v[1]] : [116.4272486, 40.0334017];
  })();
  function baseLL() { return BASE_GCJ; }

  const el = (id) => document.getElementById(id);

  const state = {
    /* 「人群」一类有 68 个点（占全部点位近一半），全是灰色图标，首屏铺得满满当当，
       新用户根本看不出这张图在讲什么 —— 默认关掉，需要时在图例里点一下即可。 */
    hidden: new Set(["people"]),
    minScore: 45,
    maxArea: 20000,
    coreOnly: true,
    fold: true,        // 点位默认折叠：只显示单字类别图标，点开才展开信息卡
    card: true,        // 展开时用信息卡（关掉则只开右侧详情面板）
    coord: true,       // 信息卡是否带经纬度
    pwOnly: false,
    dim: false,
    dimAlpha: 1,
    sens: 0.35,        // 鼠标灵敏度倍率（1 = 原始手感）
    hideStale: true,   // 隐藏「OSM+高德都查不到」的疑似已关闭点位
    selectedCrop: "sweetpotato",
    selectedPlot: null,
    visibleCount: {}
  };

  const props = new WeakMap();   // 地图要素对象 -> 业务数据

  /* ==========================================================
   * 地图初始化（高德 JS API）
   * ========================================================== */
  const CENTER = {
    lon: (D.meta.center && D.meta.center[0]) || 116.4272,
    lat: (D.meta.center && D.meta.center[1]) || 40.0334
  };

  const mapEl = el("amapContainer");
  const map = new AMap.Map("amapContainer", {
    viewMode: "2D",             // 默认二维：三维倾斜视角会让新用户分不清方向
    zoom: 16,
    center: [CENTER.lon, CENTER.lat],
    pitch: 0,
    rotation: 0,
    showLabel: true,
    mapStyle: "amap://styles/normal",
    features: ["bg", "road", "point", "building"],
    resizeEnable: true,
    dragEnable: true,
    jogEnable: false,
    animateEnable: true,
    zoomEnable: true,           // 滚轮 / 双击 / 触控板缩放全部交给高德原生
    doubleClickZoom: true,
    keyboardEnable: true,
    scrollWheel: true,
    touchZoom: true
  });
  window.__map = map;

  /* ---------------- 缩放控件 ----------------
   * 之前把 zoomEnable 关掉、自己节流滚轮，结果「滚半天才动一级」，用户以为缩放坏了。
   * 现在恢复原生缩放，再补一组显眼的 +/- 按钮和缩放级别显示。 */
  function zoomBy(dir) {
    const z = map.getZoom();
    map.setZoom(Math.min(20, Math.max(3, Math.round((z + dir * 0.5) * 2) / 2)));
  }
  function applyMouseSens() { /* 保留函数名以兼容旧调用，灵敏度现在由高德原生处理 */ }
  (function addZoomControls() {
    const bar = document.createElement("div");
    bar.className = "zoombar";
    bar.innerHTML =
      '<button class="zb" id="zb-in" title="放大">＋</button>' +
      '<button class="zb" id="zb-out" title="缩小">－</button>' +
      '<button class="zb zb-fit" id="zb-fit" title="回到片区全景">⤢</button>';
    el("map").appendChild(bar);
    el("zb-in").addEventListener("click", () => zoomBy(1));
    el("zb-out").addEventListener("click", () => zoomBy(-1));
    el("zb-fit").addEventListener("click", () => setView("top"));
  })();

  /* ---------------- 底图 ---------------- */
  let satLayer = null, roadNetLayer = null;
  function clearBasemapLayers() {
    if (satLayer) { map.remove(satLayer); satLayer = null; }
    if (roadNetLayer) { map.remove(roadNetLayer); roadNetLayer = null; }
  }
  function setBasemap(key) {
    clearBasemapLayers();
    if (key === "amap_sat") {
      try {
        satLayer = new AMap.TileLayer.Satellite();
        roadNetLayer = new AMap.TileLayer.RoadNet();
        map.add([satLayer, roadNetLayer]);
        map.setMapStyle("amap://styles/normal");
      } catch (e) {
        console.warn("[basemap] 卫星图层不可用，回退标准图", e);
        map.setMapStyle("amap://styles/normal");
      }
    } else if (key === "amap_pure") {
      map.setMapStyle("amap://styles/whitesmoke");   // 远山白：路网为主，几乎无底色
    } else {
      map.setMapStyle("amap://styles/normal");
    }
    applyDim();
  }

  /* ---- 底图淡化（默认关闭：保持高德原色、原文字） ----
   * 只压底图本身（CSS filter + 半透明），不动覆盖物。 */
  function applyDim() {
    if (!mapEl) return;
    if (state.dim) {
      const a = state.dimAlpha;
      mapEl.style.filter =
        "saturate(" + (0.85 + 0.15 * a).toFixed(2) + ") brightness(" +
        (1.18 - 0.18 * a).toFixed(2) + ") contrast(" + (0.94 + 0.06 * a).toFixed(2) + ")";
      mapEl.style.opacity = String(a);
    } else {
      mapEl.style.filter = "none";
      mapEl.style.opacity = "1";
    }
  }
  el("basemap").value = "amap";
  el("basemap").addEventListener("change", (e) => setBasemap(e.target.value));
  setBasemap("amap");

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
  /* 步行通达：路网实测 / 直线估算 */
  function walkText(p) {
    if (p.d == null) return "";
    const d = p.d >= 1000 ? (p.d / 1000).toFixed(1) + "km" : p.d + "m";
    const t = p.t != null ? Math.max(1, Math.round(p.t)) + "min" : "—";
    return (p.dsrc === "route" ? "\u6b65\u884c" : "\u76f4\u7ebf") + " " + d + "/" + t;
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

  /* 断电状态配色 */
  const PW_COLOR = { ok: "#16a34a", part: "#f59e0b", no: "#dc2626", na: "#94a3b8" };
  const PW_TEXT = { ok: "断电可用", part: "断电受限", no: "断电失效", na: "避开" };

  /* 高德风格 POI 卡片：左色块(外环=断电状态) + 名称 / 类别·断电·楼层 / 步行·坐标 */
  function makeCard(p, withCoord) {
    const col = CATS[p.c].color;
    const pwCol = PW_COLOR[p.pw] || PW_COLOR.na;
    const l1 = (p.n && p.n !== "\u672a\u547d\u540d") ? p.n : CATS[p.c].zh + "\u70b9\u4f4d";
    const l2 = CATS[p.c].zh + " · " + (PW_TEXT[p.pw] || "\u672a\u8bc4") + " · " + levelText(p);
    const w3src = [];
    if (p.d != null) w3src.push(walkText(p));
    if (withCoord) w3src.push(coordCouple(p));
    const l3 = w3src.join("　");

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

    /* 左色块：内圈=类别色，外环=断电状态色 */
    g.beginPath(); g.arc(PADX + DOT / 2, PADY + DOT / 2, DOT / 2 + 3.2, 0, Math.PI * 2);
    g.lineWidth = 3; g.strokeStyle = pwCol; g.stroke();
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
    /* 第二行：「类别 · 断电可用 · 8层·估」——断电段用状态色 */
    g.font = FF(400, 12.5);
    const segs = l2.split(" · ");
    let cx = tx;
    segs.forEach((s, i) => {
      g.fillStyle = i === 1 ? pwCol : "#6b7280";
      g.font = FF(i === 1 ? 600 : 400, 12.5);
      g.fillText(s, cx, PADY + 14 + 16);
      cx += g.measureText(s).width;
      if (i < segs.length - 1) {
        g.font = FF(400, 12.5); g.fillStyle = "#c3c9d2";
        g.fillText(" · ", cx, PADY + 14 + 16);
        cx += g.measureText(" · ").width;
      }
    });
    if (l3) {
      g.font = FF(400, 11.5); g.fillStyle = "#9aa3b2";
      g.fillText(l3, tx, PADY + 14 + 16 + 15);
    }
    return { img: c.toDataURL(), w: W, h: H };
  }

  /* 远景：只剩一个小圆点 */
  function makeDot(color, icon, dark, pwCol) {
    const S = 34, c = document.createElement("canvas");
    c.width = S * DPR; c.height = S * DPR;
    const g = c.getContext("2d");
    g.scale(DPR, DPR);
    if (pwCol) {
      g.beginPath(); g.arc(S / 2, S / 2, 13.2, 0, Math.PI * 2);
      g.lineWidth = 3; g.strokeStyle = pwCol; g.stroke();
    }
    g.beginPath(); g.arc(S / 2, S / 2, 10.5, 0, Math.PI * 2);
    g.fillStyle = color; g.fill();
    g.lineWidth = 2.6; g.strokeStyle = "rgba(255,255,255,.98)"; g.stroke();
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
      dot: makeDot(CATS[p.c].color, CATS[p.c].icon, p.c === "hardware",
                   PW_COLOR[p.pw] || PW_COLOR.na)
    };
  });

  /* ==========================================================
   * 建筑轮廓（OSM footprint，半透明叠在高德底图之上）
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
      const ring = ringOf(b.r);
      if (ring.length < 8) return;
      const path = [];
      for (let i = 0; i < ring.length; i += 2) path.push([ring[i], ring[i + 1]]);
      const base = BUILD_COLOR[b.t] || BUILD_COLOR.yes;
      const poly = new AMap.Polygon({
        path: path,
        fillColor: base,
        fillOpacity: 0.42,
        strokeColor: "#a8a49b",
        strokeWeight: 1,
        strokeOpacity: 0.8,
        zIndex: 20,
        cursor: "pointer"
      });
      poly.__baseColor = base;
      props.set(poly, { kind: "building", data: b });
      poly.on("click", () => renderDetail("building", b));
      buildingEntities.push(poly);
      poly.setMap(map);
    });
  }
  addBuildings();

  /* ==========================================================
   * 资源点（POI）
   *   默认：每个点只显示一枚「单字彩色图标」（水／食／医／电／撤／危／住／种／人）
   *   点一下：该点展开成信息卡 + 右侧详情面板；再点一下收起
   *   与缩放级别无关——没点开就永远只有那一枚图标
   * ========================================================== */
  const poiEntities = [];
  const poiEntById = new Map();      // poi id -> marker
  const expandedIds = new Set();     // 已展开的点位 id
  let adjustId = null;               // 当前处于「位置微调」状态的点位 id

  /* 折叠开关关掉 = 全部直接铺开信息卡 */
  function isExpanded(m) { return !state.fold || expandedIds.has(m.__pid); }

  function poiImage(m) {
    const c = m.__card;
    if (isExpanded(m) && state.card) {
      const k = state.coord ? c.near : c.nearNo;
      return { img: k.img, w: k.w, h: k.h, card: true };
    }
    return { img: c.dot.img, w: c.dot.w, h: c.dot.h, card: false };
  }
  function applyPoiIcon(m) {
    const s = poiImage(m);
    m.setIcon(new AMap.Icon({
      image: s.img,
      size: new AMap.Size(s.w, s.h),
      imageSize: new AMap.Size(s.w, s.h)
    }));
    /* 圆点以中心对准点位；信息卡底部有个小尖，以尖端对准 */
    m.setOffset(s.card ? new AMap.Pixel(-s.w / 2, -s.h + 1)
                       : new AMap.Pixel(-s.w / 2, -s.h / 2));
    m.setzIndex(s.card ? 220 : 120);
  }

  function addPOIs() {
    D.pois.forEach((p) => {
      const c = llOf(p);
      const card = CARD[p.i];
      const m = new AMap.Marker({
        position: [c[0], c[1]],
        icon: new AMap.Icon({
          image: card.dot.img,
          size: new AMap.Size(card.dot.w, card.dot.h),
          imageSize: new AMap.Size(card.dot.w, card.dot.h)
        }),
        offset: new AMap.Pixel(-card.dot.w / 2, -card.dot.h / 2),
        zIndex: 120,
        cursor: "pointer",
        title: p.n
      });
      m.__card = card;
      m.__pid = p.i;
      m.__cat = p.c;
      m.__baseShow = true;
      props.set(m, { kind: "poi", data: p });
      m.on("click", () => onPoiClick(m));
      /* 位置微调：常态不可拖，只有详情面板点了「微调」的那个点才接受拖动 */
      m.on("dragend", () => {
        if (adjustId !== p.i) return;
        const pos = m.getPosition();
        if (!pos) return;
        const x = pos.getLng ? pos.getLng() : pos.lng;
        const yy = pos.getLat ? pos.getLat() : pos.lat;
        FIX[p.i] = { x: x, y: yy, ts: new Date().toISOString().slice(0, 10) };
        saveFix();
        adjustId = null;
        m.setDraggable(false);
        applyPoiIcon(m);
        renderDetail("poi", p);
        toast("已校正「" + (p.n || "该点") + "」，仅保存在本机");
      });
      poiEntities.push(m);
      poiEntById.set(p.i, m);
      m.setMap(map);
    });
  }
  addPOIs();

  let currentPoiId = null;
  function onPoiClick(m) {
    const p = props.get(m).data;
    const open = expandedIds.has(p.i);
    if (open) expandedIds.delete(p.i);
    else { expandedIds.add(p.i); state.fold = true; }
    applyPoiIcon(m);
    if (!open) {
      currentPoiId = p.i;
      renderDetail("poi", p);
      /* 只在目标不在视野里时居中，避免每点一下地图就跳 */
      try {
        if (!map.getBounds().contains(new AMap.LngLat(p.x, p.y))) map.setCenter([p.x, p.y]);
      } catch (e) { /* 边界接口拿不到就算了 */ }
    } else if (currentPoiId === p.i) {
      currentPoiId = null;
      const box = el("detail");
      box.className = "detail empty";
      box.textContent = "在地图上点击任意资源点或紫色地块";
    }
    updateStats();
  }

  /* 展开某个点位（搜索跳转、备用方案跳转时用） */
  function unfoldPoi(id) {
    expandedIds.add(id);
    const m = poiEntById.get(id);
    if (m) applyPoiIcon(m);
    return true;
  }
  function collapseAll() {
    expandedIds.clear();
    refreshPOIStyle();
  }
  function expandAll() {
    poiEntities.forEach((m) => { if (m.__baseShow !== false) expandedIds.add(m.__pid); });
    refreshPOIStyle();
  }
  function refreshPOIStyle() {
    poiEntities.forEach((m) => applyPoiIcon(m));
    updateStats();
  }

  /* ==========================================================
   * 撤离路网（主干道）+ 桥隧卡点（单点失效）
   * ========================================================== */
  const ROAD_WIDTH = { trunk: 7, primary: 5.5, secondary: 4, tertiary: 3 };
  const roadEntities = [];
  function addRoads() {
    (D.roads || []).forEach((r) => {
      const pts = ringOf(r.r);
      if (pts.length < 4) return;
      const path = [];
      for (let i = 0; i < pts.length; i += 2) path.push([pts[i], pts[i + 1]]);
      const line = new AMap.Polyline({
        path: path,
        strokeColor: "#10B981",
        strokeWeight: ROAD_WIDTH[r.cls] || 3,
        strokeOpacity: 0.95,
        lineJoin: "round",
        zIndex: 40,
        cursor: "pointer"
      });
      props.set(line, { kind: "road", data: r });
      line.on("click", () => renderDetail("road", r));
      roadEntities.push(line);
      line.setMap(map);
    });
  }
  addRoads();

  const chokeEntities = [];
  function addChokes() {
    (D.chokes || []).forEach((k) => {
      const c = llOf(k);
      const mk = new AMap.Marker({
        position: [c[0], c[1]],
        icon: new AMap.Icon({
          image: chokeIcon(k.k),
          size: new AMap.Size(26, 26),
          imageSize: new AMap.Size(26, 26)
        }),
        offset: new AMap.Pixel(-13, -26),
        zIndex: 150,
        cursor: "pointer"
      });
      props.set(mk, { kind: "choke", data: k });
      mk.on("click", () => renderDetail("choke", k));
      chokeEntities.push(mk);
      mk.setMap(map);

      const tx = new AMap.Text({
        text: k.n,
        position: [c[0], c[1]],
        anchor: "bottom-center",
        offset: new AMap.Pixel(0, -28),
        zIndex: 151,
        style: {
          "font-size": "11px", "font-weight": "600", color: "#ffffff",
          "background-color": "transparent", border: "none", padding: "0",
          "text-shadow": "-1px -1px 0 #7f1d1d, 1px -1px 0 #7f1d1d, -1px 1px 0 #7f1d1d, 1px 1px 0 #7f1d1d"
        }
      });
      props.set(tx, { kind: "choke", data: k });
      tx.on("click", () => renderDetail("choke", k));
      chokeEntities.push(tx);
      tx.setMap(map);
    });
  }
  function chokeIcon(kind) {
    const S = 26, c = document.createElement("canvas");
    c.width = S * DPR; c.height = S * DPR;
    const g = c.getContext("2d");
    g.scale(DPR, DPR);
    g.beginPath();
    g.moveTo(S / 2, 1.5); g.lineTo(S - 2, S - 6); g.lineTo(2, S - 6); g.closePath();
    g.fillStyle = "#dc2626"; g.fill();
    g.lineWidth = 2; g.strokeStyle = "#ffffff"; g.stroke();
    g.fillStyle = "#ffffff";
    g.font = "700 11px 'PingFang SC',sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(kind === "\u68c0\u67e5\u70b9" ? "！" : "△", S / 2, S / 2 + 3);
    return c.toDataURL();
  }
  addChokes();

  /* ==========================================================
   * 低洼洪水区（河道两侧缓冲带）—— 属危险源，用于规划绕行
   * ========================================================== */
  const floodEntities = [];
  function ringPath(ring) {
    const path = [];
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < ring.length; i += 2) {
      path.push([ring[i], ring[i + 1]]);
      sx += ring[i]; sy += ring[i + 1]; n++;
    }
    return { path: path, center: n ? [sx / n, sy / n] : null };
  }
  function addFloods() {
    (D.floods || []).forEach((f) => {
      const g = ringPath(ringOf(f.r));
      if (g.path.length < 4) return;
      const poly = new AMap.Polygon({
        path: g.path,
        fillColor: "#9333EA",
        fillOpacity: 0.28,
        strokeColor: "#9333EA",
        strokeWeight: 1,
        strokeOpacity: 0.65,
        zIndex: 30,
        cursor: "pointer"
      });
      props.set(poly, { kind: "flood", data: f });
      poly.on("click", () => renderDetail("flood", f));
      floodEntities.push(poly);
      poly.setMap(map);

      if (g.center) {
        const tx = new AMap.Text({
          text: f.n + " · 低洼内涝带",
          position: g.center,
          anchor: "center",
          zIndex: 31,
          style: {
            "font-size": "11px", "font-weight": "600", color: "#581c87",
            "background-color": "rgba(255,255,255,.82)", "border-radius": "4px",
            border: "none", padding: "1px 5px"
          }
        });
        props.set(tx, { kind: "flood", data: f });
        tx.on("click", () => renderDetail("flood", f));
        floodEntities.push(tx);
        tx.setMap(map);
      }
    });
  }
  addFloods();

  /* ==========================================================
   * 人群密度：建筑按估算人口着色（灾时最大变量是人群）
   * ========================================================== */
  function popColor(ph) {
    // 人/公顷 → 绿→黄→橙→红
    if (ph >= 900) return "#b91c1c";
    if (ph >= 600) return "#ea580c";
    if (ph >= 350) return "#f59e0b";
    if (ph >= 150) return "#84cc16";
    return "#22c55e";
  }
  function applyPeople(on) {
    buildingEntities.forEach((poly) => {
      const b = props.get(poly).data;
      poly.setOptions({
        fillColor: on ? popColor(b.ph || 0) : (poly.__baseColor || BUILD_COLOR.yes),
        fillOpacity: on ? 0.62 : 0.42
      });
    });
  }

  /* ==========================================================
   * 可种植地块
   * ========================================================== */
  const plotEntities = [];
  function addPlots() {
    D.plots.forEach((p, idx) => {
      const g = ringPath(ringOf(p.r));
      if (g.path.length < 4) return;
      const alpha = 0.10 + 0.22 * (p.s / 100);
      const poly = new AMap.Polygon({
        path: g.path,
        fillColor: PLOT_COLOR,
        fillOpacity: alpha,
        strokeColor: PLOT_COLOR,
        strokeWeight: 2,
        strokeOpacity: 0.95,
        zIndex: 60,
        cursor: "pointer"
      });
      poly.__kindPoly = true;
      props.set(poly, { kind: "plot", data: p, idx });
      poly.on("click", () => { state.selectedPlot = p; renderDetail("plot", p); });
      plotEntities.push(poly);
      poly.setMap(map);

      if (g.center) {
        const tx = new AMap.Text({
          text: fmtArea(p.a) + " · " + p.s,
          position: g.center,
          anchor: "center",
          zIndex: 61,
          style: {
            "font-size": "11px", "font-weight": "600", color: "#ffffff",
            "background-color": "transparent", border: "none", padding: "0",
            "text-shadow": "-1px -1px 0 #3b0764, 1px -1px 0 #3b0764, -1px 1px 0 #3b0764, 1px 1px 0 #3b0764"
          }
        });
        props.set(tx, { kind: "plot", data: p, idx });
        tx.on("click", () => { state.selectedPlot = p; renderDetail("plot", p); });
        plotEntities.push(tx);
        tx.setMap(map);
      }
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


  /* ==========================================================
   * 图例与统计
   * ========================================================== */
  function buildLegend() {
    const box = el("legend");
    box.innerHTML = "";

    /* 九个图层挤成一列时，一屏只看得到前三项（水／食物／医疗）——被测用户以为
       只能筛这三类。改成两列网格一屏铺满，并给一组一键筛选按钮。 */
    if (!document.getElementById("lg-tools")) {
      const tools = document.createElement("div");
      tools.id = "lg-tools";
      tools.className = "lg-tools";
      tools.innerHTML =
        '<button class="mini-btn" data-act="all">全部显示</button>' +
        '<button class="mini-btn" data-act="core">只看生存必需</button>' +
        '<button class="mini-btn" data-act="none">全部隐藏</button>';
      box.parentNode.insertBefore(tools, box.nextSibling);
      tools.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        const act = b.dataset.act;
        if (act === "all") state.hidden.clear();
        else if (act === "none") CAT_ORDER.forEach((k) => state.hidden.add(k));
        else {   /* 生存必需：水 / 食物 / 医疗 / 能源通信 / 据点 */
          CAT_ORDER.forEach((k) => state.hidden.add(k));
          ["water", "food", "medical", "energy", "strong"].forEach((k) => state.hidden.delete(k));
        }
        refreshVisibility();
      });
    }

    CAT_ORDER.forEach((k) => {
      const c = CATS[k];
      /* 地块不在 D.pois 里，单独取，否则图例永远显示 0 */
      const n = (k === PLOT_KEY)
        ? (D.plots || []).length
        : D.pois.filter((p) => p.c === k).length;
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
    water: "水厂泵站、水塔、井、河流湖泊（室外需净化）",
    food: "超市货架 / 菜场 / 批发后仓 / 生鲜",
    medical: "医院急诊、诊所、药店、AED",
    energy: "变电站、加油站、通信塔、充电站",
    egress: "撤离路网、汽修保障、桥隧单点",
    hazard: "化工、监狱、油气储库——规划时绕行",
    strong: "高层酒店据点 / 建材加固物资",
    plot: "可种地（采光通风评分 + 作物产能）",
    people: "出入口、地铁、学校——点很多，默认关闭",
    // 旧版兜底
    supermarket: "主食 / 罐头 / 瓶装水集中点",
    medical2: "医院、门诊、药房与急救耗材",
    hotel: "高层楼宇据点：出入口可控、结构可靠",
    carrepair: "工具、铅酸电池、耗材与零配件",
    fuel: "燃油补给；断电后不再可用",
    hardware: "钢筋水泥模板、板材、五金工具",
    farm: "地缘推算的连片空地 + 农资种子渠道"
  };

  function refreshVisibility() {
    poiEntities.forEach((m) => {
      const p = props.get(m).data;
      const okCat = !state.hidden.has(p.c);
      const okPw = !state.pwOnly || p.pw === "ok" || p.pw === "part";
      const okStale = !state.hideStale || p._v !== "dead";
      m.__baseShow = okCat && okPw && okStale;   // 折叠只影响图标样式，不影响这点位该不该出现
      if (m.__baseShow) m.show(); else m.hide();
    });
    plotEntities.forEach((o) => {
      const p = props.get(o).data;
      const ok = (!state.hidden.has(PLOT_KEY)) &&
                 p.s >= state.minScore &&
                 p.a <= state.maxArea &&
                 /* 原阈值 200 m 对全部 84 块地都成立（实际范围 4–165 m），开关等于没用；
                    收紧到 50 m 才有区分度（49 / 84 块） */
                 (!state.coreOnly || p.nb <= PLOT_NEAR_M);
      o.__vis = ok;
      if (ok) o.show(); else o.hide();
    });
    floodEntities.forEach((o) => {
      const ok = !state.hidden.has("hazard");
      o.__vis = ok;
      if (ok) o.show(); else o.hide();
    });
    document.querySelectorAll("#legend .lg").forEach((d) => {
      d.classList.toggle("off", state.hidden.has(d.dataset.cat));
    });
    refreshPOIStyle();
  }

  function updateStats() {
    const counts = {};
    CAT_ORDER.forEach((k) => (counts[k] = 0));
    poiEntities.forEach((e) => {
      if (e.__baseShow === false) return;   // 折叠掉的点位仍计入统计，否则一折叠数字就掉
      const p = props.get(e).data;
      counts[p.c] = (counts[p.c] || 0) + 1;
    });
    state.visibleCount = counts;

    /* 断电可用性统计：勾了筛选就报筛选后的口径，否则会让用户以为开关没生效 */
    const pw = { ok: 0, part: 0, no: 0, na: 0 };
    let pwTotal = 0;
    poiEntities.forEach((e) => {
      const p = props.get(e).data;
      if (state.hidden.has(p.c)) return;
      pwTotal++;
      if (e.__baseShow === false) return;
      pw[p.pw || "na"]++;
    });
    const kept = pw.ok + pw.part;
    el("pw-count").textContent = state.pwOnly
      ? `已保留 ${kept} / ${pwTotal}`
      : `可用 ${pw.ok} · 受限 ${pw.part} · 失效 ${pw.no}`;

    const visiblePlots = plotEntities.filter((e) => e.__kindPoly && e.__vis !== false);
    const area = visiblePlots.reduce((s, e) => s + props.get(e).data.a, 0);
    /* 图例上的地块计数跟着筛选走（地块不在 pois 里，得单独同步） */
    const lgPlot = document.querySelector('#legend .lg[data-cat="' + PLOT_KEY + '"] .ct');
    if (lgPlot) lgPlot.textContent = visiblePlots.length;
    const top = Math.max(0, ...visiblePlots.map((e) => props.get(e).data.s));

    let html = "";
    CAT_ORDER.forEach((k) => {
      html += `<div class="row"><i style="background:${CATS[k].color}"></i>${CATS[k].zh}<b>${counts[k]}</b></div>`;
    });
    html += `<div class="row"><i style="background:${PLOT_COLOR}"></i>候选种植地块<b>${visiblePlots.length}</b></div>`;
    html += `<div class="row"><i style="background:#c9d2de"></i>建筑体块<b>${buildingEntities.length}</b></div>`;
    if (state.fold) {
      html += `<div class="row"><i style="background:#94a3b8"></i>已展开信息卡<b>${expandedIds.size}</b></div>`;
    }
    html += `<div class="note">可视地块合计 ${fmtArea(area)}，最高评分 ${top.toFixed(0)}。
              OSM 在城区的 POI 覆盖并不完整，加油站等类别已向北苑外围做半径扩展搜索。</div>`;
    el("stats").innerHTML = html;
    el("stat-count").textContent = D.pois.length + " 个点位";
  }

  /* ==========================================================
   * 详情面板
   * ========================================================== */
  const SUB_ZH = D.sub_zh || {
    hotel: "酒店宾馆", structure: "高层/综合体", care: "养老照护机构",
    tower: "写字楼 / 大厦", apartment: "公寓住宅",
    hospital: "医院", clinic: "门诊 / 卫生服务机构", pharma: "药房", vet: "宠物医疗",
    retail: "零售超市", wholesale: "批发市场",
    greenspace: "绿地 / 空地", seed: "农资 / 花卉 / 种子"
  };

  /* 6 类要素的通用提醒（断电/垂直/人群三个易漏点） */
  const CAT_NOTE = {
    water: "断水通常先于断电发生。室外水源一律视为<b>需净化</b>：煮沸 3–5 分钟，或过滤＋含氯消毒片。",
    food: "先清货架、后清后仓。货架库存 72 小时内会被抢空；后仓要破拆、人力转运不现实——优先级按步行距离排。",
    medical: "断电后只有带柴油发电机的医院还能手术；普通药店可现金取药但冷藏失效。重伤只能送有发电机的医院。",
    energy: "加油机油泵需电，断电站内取不出油；基站备电通常 4–8 小时后退服，通信窗口很短。",
    egress: "单条路线遇桥断/设卡即作废，必须准备 ≥2 条不同方向的路线，并避开桥隧单点。",
    hazard: "危险源用于规划时<b>绕行</b>：按上风向与爆炸半径留缓冲，撤离路线不要压在它旁边。",
    strong: "高层酒店电梯停运后只能走楼梯，10 层以上运补困难；低层或裙房更适合做据点。",
    plot: "种植属中长期方案：首年实际收成按测算值五折预估，且需水源与围栏配合。",
    people: "灾时最大变量是<b>人群流动</b>，不是资源分布。密集出入口撤离时要避开，改走侧门/消防通道。"
  };

  const POI_BY_ID = {};
  D.pois.forEach((p) => { POI_BY_ID[p.i] = p; });

  function renderDetail(kind, data) {
    const box = el("detail");
    if (kind === "plot") return renderPlot(box, data);
    if (kind === "building") return renderBuilding(box, data);
    if (kind === "road") return renderRoad(box, data);
    if (kind === "choke") return renderChoke(box, data);
    if (kind === "flood") return renderFlood(box, data);
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

  /* gcj2wgs 已在文件顶部定义（渲染层要用），这里不再重复实现 */

  /* ① 坐标 + 实际步行通达（不是直线距离） */
  function accessRow(p) {
    if (p.d == null) return "未测算";
    const d = p.d >= 1000 ? (p.d / 1000).toFixed(2) + " km" : p.d + " m";
    const t = p.t != null ? Math.max(1, Math.round(p.t)) + " 分钟" : "—";
    const src = p.dsrc === "route"
      ? "步行路网实测（OSRM）"
      : "直线距离 ×1.35 估算（该点未取到路网）";
    return `${d}　步行约 ${t}<br><span class="sub">${src}</span>`;
  }

  /* ④ 备用方案：同类第二近点，可点击跳转 */
  function fbRow(p) {
    const f = p.fb;
    if (!f) return "本类无第二点位，需向外围扩展区找替代";
    const d = f.d >= 1000 ? (f.d / 1000).toFixed(2) + " km" : f.d + " m";
    const t = f.t != null ? Math.max(1, Math.round(f.t)) + " 分钟" : "—";
    return `<a href="javascript:void(0)" class="fb-link" data-fb="${esc(f.i || f.n)}">${esc(f.n)}</a>
      <br><span class="sub">${d}　步行约 ${t}</span>`;
  }

  /* ---------------- 数据纠错反馈 ----------------
   * OSM 是众包数据，点位可能已经拆除 / 搬走 / 改名。
   * 每个点都给一枚「报错」按钮：点一下复制一条结构化反馈，
   * 用户发回来后由维护者批量写进 tools/fix_data.py 的 REMOVE / RECLASS 表。 */
  const REPORT_LABEL = { gone: "已拆除 / 搬走", wrong: "信息有误", moved: "位置偏移" };

  function reportHtml() {
    return `<div class="rpt"><span class="rpt-t">这里不对？</span>`
      + Object.keys(REPORT_LABEL).map((k) =>
        `<button class="rpt-b" data-rpt="${k}">${REPORT_LABEL[k]}</button>`).join("")
      + `<div class="rpt-s">点一下会复制一条反馈，发给我就能改数据</div></div>`;
  }

  function copyText(s) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(s);
        return;
      }
    } catch (e) {}
    try {
      const ta = document.createElement("textarea");
      ta.value = s;
      ta.style.cssText = "position:fixed;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (e) {}
  }

  function bindReport(box, p) {
    box.querySelectorAll(".rpt-b").forEach((b) => {
      b.addEventListener("click", () => {
        const kind = REPORT_LABEL[b.dataset.rpt] || "纠错";
        const today = new Date().toISOString().slice(0, 10);
        const txt = `[${kind}] ${p.i || "-"} | ${p.n || "-"} | `
          + `${p.c}${p.sub ? "/" + p.sub : ""} | ${today}`;
        copyText(txt);
        try {
          const arr = JSON.parse(localStorage.getItem("pm_report") || "[]");
          arr.push(txt);
          localStorage.setItem("pm_report", JSON.stringify(arr));
        } catch (e) {}
        const old = b.textContent;
        b.textContent = "已复制 ✓";
        b.classList.add("ok");
        setTimeout(() => { b.textContent = old; b.classList.remove("ok"); }, 2000);
      });
    });
  }

  /* 数据核验徽章：结论由 tools/amap_verify.py + refresh_check.py 预先算好烧进数据 */
  function ckRow(p) {
    const MAP = {
      ok:   ["ok",   "两处数据源都能查到"],
      warn: ["warn", "位置在但名称对不上，可能换了商户"],
      dead: ["dead", "OSM 与高德都查不到，疑似已关闭 / 搬走"],
      unk:  ["unk",  "设施型点位，无法自动核验"]
    };
    const v = MAP[p._v] || MAP.unk;
    let s = `<span class="ck ${v[0]}">${v[1]}</span>`;
    if (p.amn) s += `<br><span class="sub">高德收录名：${esc(p.amn)}</span>`;
    const osmTxt = p.osm === "gone" ? "已删除" : (p.osm === "unknown" ? "未查到" : "仍在");
    const amTxt = p.am === "alive" ? "有" : (p.am === "gone" ? "查无" : (p.am === "renamed" ? "名称不同" : "未判定"));
    s += `<br><span class="sub">交叉核验 ${esc(p.ck || "—")} ｜ OSM ${osmTxt} ｜ 高德 ${amTxt}</span>`;
    return s;
  }

  /* ⑦ 数据来源：给出可点开的原始记录，让每条结论都能自己核一遍 */
  function srcRow(p) {
    const ll = llOf(p);
    let s = "";
    const m = /^(node|way|relation)\/(\d+)$/.exec(p.i || "");
    if (m) {
      s += `<a class="src" href="https://www.openstreetmap.org/${m[1]}/${m[2]}" target="_blank" rel="noopener">`
        + `在 OpenStreetMap 打开原始对象 ↗</a>`
        + `<br><span class="sub">OSM ${m[1]} #${m[2]}　许可 ODbL 1.0　作者：OSM contributors</span><br>`;
    }
    s += `<a class="src" href="https://uri.amap.com/marker?position=${ll[0]},${ll[1]}`
      + `&name=${encodeURIComponent(p.n || "")}&coordinate=gaode&callnative=0" target="_blank" rel="noopener">`
      + `在高德地图核对这个位置 ↗</a>`;
    s += `<br><span class="sub">快照：${esc(D.meta.generated || "—")}（Overpass API 抓取）　`
      + `步行通达：${p.dsrc === "route" ? "OSRM 路网实测" : "直线 ×1.35 估算"}</span>`;
    return s;
  }

  /* ⑧ 位置校正：偏了就拖一下，只改本机 */
  function fixRow(p) {
    const f = FIX[p.i];
    if (!f) {
      return `<button class="rpt-b" data-adjust="1">位置偏了？点这里微调</button>
        <br><span class="sub">点后拖动地图上的图标到实地位置，松手即保存（只存在你这台设备）</span>`;
    }
    const dm = Math.round(distM({ x: p.x, y: p.y }, { x: f.x, y: f.y }));
    return `<b style="color:#b45309">已手动校正</b>　偏移 ${dm} m
      <br><span class="sub">GCJ-02 ${f.x.toFixed(6)}, ${f.y.toFixed(6)}　原始 ${p.x.toFixed(6)}, ${p.y.toFixed(6)}</span>
      <div class="rpt"><button class="rpt-b" data-unfix="1">恢复原始位置</button></div>`;
  }

  function startAdjust(p) {
    const m = poiEntById.get(p.i);
    if (!m) return toast("地图上找不到这个点");
    adjustId = p.i;
    m.setDraggable(true);
    try { map.setCenter(llOf(p)); map.setZoom(18); } catch (e) {}
    toast("拖动地图上的图标到实地位置，松手即保存");
  }

  function renderPOI(box, p) {
    const c = CATS[p.c];
    const pw = p.pw || "na";
    const rows = [];

    /* 五个必备字段，按顺序 ①—⑤ */
    rows.push(["① 坐标 / 通达", accessRow(p)]);
    rows.push(["② 断电后可用性",
      `<span class="pwtag ${pw}">${PW_TEXT[pw] || "未评估"}</span><br><span class="sub">${esc(p.pwr || "未评估")}</span>`]);
    rows.push(["③ 容量 / 存量", esc(p.cap || "未评估")]);
    rows.push(["④ 备用方案", fbRow(p)]);
    rows.push(["⑤ 最近核实",
      `<b style="color:#b45309">${esc(p.vf || "—")}　未现场核实</b>
       <br><span class="sub">OSM 快照日期，非实地踏勘；用前需现场确认</span>`]);
    rows.push(["⑥ 数据核验", ckRow(p)]);
    rows.push(["⑦ 数据来源", srcRow(p)]);
    rows.push(["⑧ 位置校正", fixRow(p)]);

    /* 垂直维度 */
    rows.push(["楼层", levelFull(p)]);
    rows.push(["垂直维度", esc(p.vt || "无垂直信息")]);
    rows.push(["楼号 / 门牌", p.hn ? esc(p.hn) : "OSM 未标注（需现场核实）"]);
    rows.push(["类别", `${c.zh}${p.sub ? " · " + (SUB_ZH[p.sub] || p.sub) : ""}`]);
    rows.push(...llRows(p));

    const t = p.tags || {};
    if (t["opening_hours"]) rows.push(["营业时间", esc(t["opening_hours"])]);
    if (t.phone) rows.push(["电话", esc(t.phone)]);

    let html = `<h3>${esc(p.n)}</h3>
      <span class="badge" style="background:${c.color};color:${p.c === "hardware" ? "#333" : "#fff"}">${c.zh}</span>
      <span class="pwtag ${pw}" style="margin-left:5px">${PW_TEXT[pw] || "未评估"}</span>
      <table>${rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join("")}</table>`;

    const note = CAT_NOTE[p.c];
    if (note) html += `<div class="adv">${note}</div>`;

    const extra = Object.keys(t).filter((k) => k !== "name" && k !== "name:en");
    if (extra.length) {
      html += `<div class="tags">OSM 原始标签：${extra.slice(0, 8).map((k) => esc(k + "=" + t[k])).join(" · ")}</div>`;
    }
    html += reportHtml();
    box.className = "detail";
    box.innerHTML = html;
    bindReport(box, p);
    const adj = box.querySelector("[data-adjust]");
    if (adj) adj.addEventListener("click", () => startAdjust(p));
    const unf = box.querySelector("[data-unfix]");
    if (unf) unf.addEventListener("click", () => {
      delete FIX[p.i];
      saveFix();
      const ent = poiEntById.get(p.i);
      if (ent) { ent.setPosition([p.x, p.y]); applyPoiIcon(ent); }
      renderDetail("poi", p);
      toast("已恢复原始位置");
    });
    box.querySelectorAll(".fb-link").forEach((a) => {
      a.addEventListener("click", () => {
        const key = a.dataset.fb;
        const target = POI_BY_ID[key] || D.pois.filter((o) => o.n === key)[0];
        if (!target) return;
        unfoldPoi(target.i);
        const ent = poiEntities.filter((e) => (props.get(e) || {}).data === target)[0];
        if (ent) { flyToEntity(ent); renderPOI(box, target); }
      });
    });
  }

  function renderFlood(box, f) {
    box.className = "detail";
    box.innerHTML = `<h3>${esc(f.n)} · 低洼内涝带</h3>
      <span class="badge" style="background:#9333EA">危险源</span>
      <table>
        <tr><td>类型</td><td>水体两侧各 45 m 的几何缓冲带（无高程数据时用它近似低洼区）</td></tr>
        <tr><td>风险</td><td>暴雨内涝优先淹没，且断电后排水泵站失效会加重</td></tr>
        <tr><td>用途</td><td>不在此设点位；撤离路线绕开，取水源时需评估上游污染</td></tr>
      </table>
      <div class="adv">这条带是<b>按几何推算</b>的，不是真实洪水淹没图。真实内涝要看高程与排水管网，现场核实前不要当依据。</div>`;
  }

  function renderRoad(box, r) {
    const zh = { trunk: "快速路 / 国道", primary: "主干道", secondary: "次干道", tertiary: "支路" };
    box.className = "detail";
    box.innerHTML = `<h3>${esc(r.n)}</h3>
      <span class="badge" style="background:#10B981">撤离路网</span>
      <table>
        <tr><td>道路等级</td><td>${zh[r.cls] || esc(r.cls)}</td></tr>
        <tr><td>灾时通行</td><td>信号灯失效后通行能力按 3–5 折估算；主干道 72 小时内易被占满</td></tr>
        <tr><td>单点失效</td><td>优先看本段是否压在桥隧上——见「桥隧·卡点」图层</td></tr>
      </table>
      <div class="adv">撤离至少准备 <b>2 条不同方向</b>的路线。本条只是候选之一，不要把它当唯一出口。</div>`;
  }

  function renderChoke(box, k) {
    box.className = "detail";
    box.innerHTML = `<h3>${esc(k.n)}</h3>
      <span class="badge" style="background:#dc2626">${esc(k.k)}</span>
      <table>
        <tr><td>类型</td><td>${esc(k.k)}——典型<b>单点失效</b>位置</td></tr>
        <tr><td>GCJ-02</td><td>${k.y.toFixed(6)}, ${k.x.toFixed(6)}</td></tr>
        <tr><td>风险</td><td>一旦堵死/封闭，经过它的整条撤离路线作废</td></tr>
      </table>
      <div class="adv">凡经过本点的撤离路线，都必须再备一条不经过它的替代路线。</div>`;
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
        ${b.pop != null ? `<tr><td>估算人口</td><td>约 ${b.pop} 人（建筑面积×层数÷32㎡/人，粗估）</td></tr>` : ""}
        ${b.ph != null ? `<tr><td>人口密度</td><td>${b.ph} 人/公顷　${b.ph >= 600 ? "<b style=\"color:#b91c1c\">高密度·撤离拥堵风险</b>" : b.ph >= 350 ? "中高密度" : "低密度"}</td></tr>` : ""}
        ${b.lv ? `<tr><td>垂直维度</td><td>${b.lv >= 15 ? "≥15 层，按规范应设避难层（需现场确认）" : b.lv >= 8 ? "电梯停运后高层运补困难" : "多层，楼梯可达"}　屋顶约 ${Math.round(b.a)} ㎡可集雨</td></tr>` : ""}
        <tr><td>GCJ-02</td><td>${cy0.toFixed(6)}, ${cx0.toFixed(6)}</td></tr>
        ${wgs ? `<tr><td>WGS-84</td><td>N ${wgs[1].toFixed(6)}°　E ${wgs[0].toFixed(6)}°</td></tr>` : ""}
      </table>
      <div class="adv">${b.e
        ? "该楼 OSM 未提供层数标注，高度是按建筑类型与占地规模推算的量级参考，不要拿它去做工程判断。"
        : "该楼高度取自 OSM 的 height / building:levels 标注。"}<br>
        <b>灾时提醒：</b>这栋楼的人口是撤离时的主要负载——出入口宽度、楼梯通行能力才是瓶颈，不是道路。</div>`;
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
      <span class="badge" style="background:${PLOT_COLOR}">可种植地</span>
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
  function midOfRing(r) {
    if (!r || r.length < 2) return null;
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < r.length; i += 2) { sx += r[i]; sy += r[i + 1]; n++; }
    return [sx / n, sy / n];
  }
  function flyToEntity(obj) {
    const o = props.get(obj);
    if (!o) return;
    let center = null, zoom = 17;
    if (o.kind === "poi" || o.kind === "choke") { center = [o.data.x, o.data.y]; zoom = 17.5; }
    else if (o.kind === "plot") { center = midOfRing(o.data.r); zoom = 17; }
    else if (o.kind === "road" || o.kind === "flood") { center = midOfRing(o.data.r); zoom = 15.5; }
    else { center = midOfRing(o.data.r); zoom = 17; }
    if (center) map.setZoomAndCenter(zoom, center);
  }
  function focusOn(lon, lat, zoom) {
    map.setZoomAndCenter(zoom || 17, [lon, lat]);
  }

  window.__show = renderDetail;   // 调试 / 自动化测试入口
  window.__pick = (obj) => {
    const o = props.get(obj);
    if (o) { renderDetail(o.kind, o.data); flyToEntity(obj); }
  };

  /* 光标经纬度 / 到基地距离 */
  map.on("mousemove", (e) => {
    const g = e.lnglat;
    if (!g) return;
    const lon = g.getLng(), lat = g.getLat();
    el("hud-ll").textContent = lon.toFixed(5) + ", " + lat.toFixed(5);
    const b = baseLL();
    const d = distMeters(lon, lat, b[0], b[1]);
    el("hud-dist").textContent = (d / 1000).toFixed(1) + " km";
  });

  /* 比例尺 + 缩放级别：按 Web 墨卡托反算 米/像素 */
  const SCALE_PX = 60;
  function metersPerPixel() {
    const z = map.getZoom();
    const c = map.getCenter();
    const lat = c ? (c.getLat ? c.getLat() : c.lat) : CENTER.lat;
    return 156543.03392804097 * Math.cos((lat * Math.PI) / 180) / Math.pow(2, z);
  }
  function niceRound(v) {
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    const step = n >= 5 ? 5 : n >= 2 ? 2 : 1;
    return step * p;
  }
  function updateHud() {
    el("hud-alt").textContent = "Z" + Number(map.getZoom()).toFixed(1);
    const mpp = metersPerPixel();
    if (!mpp) return;
    const barMeters = niceRound(mpp * SCALE_PX);
    const px = Math.round(barMeters / mpp);
    el("scale-text").innerHTML =
      '<span class="bar" style="width:' + Math.min(160, px) + 'px"></span>' +
      (barMeters >= 1000 ? (barMeters / 1000).toFixed(1) + " km" : Math.round(barMeters) + " m");
  }
  map.on("zoomend", updateHud);
  map.on("moveend", updateHud);
  map.on("complete", updateHud);

  /* ---------------- 侧栏控件 ---------------- */
  function setVis(list, on) {
    list.forEach((o) => { o.__vis = on; if (on) o.show(); else o.hide(); });
  }
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
  el("tg-build").addEventListener("change", (e) => setVis(buildingEntities, e.target.checked));
  el("tg-roads").addEventListener("change", (e) => setVis(roadEntities, e.target.checked));
  el("tg-choke").addEventListener("change", (e) => setVis(chokeEntities, e.target.checked));
  el("tg-people").addEventListener("change", (e) => applyPeople(e.target.checked));
  el("tg-pw").addEventListener("change", (e) => {
    state.pwOnly = e.target.checked;
    refreshVisibility();
  });
  el("tg-label").addEventListener("change", (e) => {
    state.card = e.target.checked;
    refreshPOIStyle();
  });
  el("tg-coord").addEventListener("change", (e) => {
    state.coord = e.target.checked;
    refreshPOIStyle();
  });
  el("tg-fold").addEventListener("change", (e) => {
    state.fold = e.target.checked;      // 勾上 = 默认折叠，只有点开的才展开
    refreshPOIStyle();
  });
  /* 灵敏度滑块已移除（原生缩放后不需要），这里做空值保护以便旧页面也能跑 */
  if (el("r-sens")) {
    el("r-sens").addEventListener("input", (e) => {
      state.sens = parseFloat(e.target.value) / 100;
      el("v-sens").textContent = Math.round(state.sens * 100) + "%";
      applyMouseSens(state.sens);
    });
  }
  el("btn-fold-all").addEventListener("click", collapseAll);
  el("btn-unfold-all").addEventListener("click", expandAll);
  el("tg-core").addEventListener("change", (e) => {
    state.coreOnly = e.target.checked;
    refreshVisibility();
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
  const tgStale = el("tg-stale");
  if (tgStale) {
    const nDead = D.pois.filter((p) => p._v === "dead").length;
    const nb = document.getElementById("n-stale");
    if (nb) nb.textContent = nDead;
    // 双方都已查无的点位清理完毕后，这个开关没有意义，直接隐藏
    const wrap = document.getElementById("tg-stale-wrap");
    if (wrap) wrap.style.display = nDead ? "" : "none";
    tgStale.checked = state.hideStale;
    tgStale.addEventListener("change", (e) => {
      state.hideStale = e.target.checked;
      refreshVisibility();
    });
  }
  el("btn-reset").addEventListener("click", () => setView("top"));
  const sw = document.getElementById("btn-switch");
  if (sw) sw.addEventListener("click", () => {
    try { localStorage.removeItem("pm_device"); } catch (e) {}
    location.href = "index.html";
  });
  el("viewmode").addEventListener("change", (e) => setView(e.target.value));

  /* ---------------- 视角 ---------------- */
  /* 二维模式不支持 pitch，四档全是正射俯视，只改级别 */
  function setView(mode) {
    const cfg = {
      street:   { zoom: 18   },   // 街区贴近
      normal:   { zoom: 16.5 },   // 标准俯视
      top:      { zoom: 15.5 },   // 片区全景（默认）
      district: { zoom: 13.5 }    // 周边地区
    }[mode] || { zoom: 15.5 };
    map.setZoomAndCenter(cfg.zoom, [CENTER.lon, CENTER.lat]);
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
          /* 搜索即显示：类别被隐藏就放开，点位被折叠就展开 */
          if (state.hidden.has(p.c)) { state.hidden.delete(p.c); refreshVisibility(); }
          unfoldPoi(p.i);
          currentPoiId = p.i;
          focusOn(p.x, p.y, 17.5);
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
  const nRoute = D.pois.filter((p) => p.dsrc === "route").length;
  const nOk = D.pois.filter((p) => p.pw === "ok" || p.pw === "part").length;

  el("credits-list").innerHTML = [
    `<b>本图按「最低可用配置」组织</b>：6 类要素齐全（水／食物／医疗／能源通信／撤离路线／危险源），
     每个点位带 5 个字段：① 坐标+步行通达　② 断电后可用性　③ 容量存量　④ 备用方案　⑤ 核实时间。`,
    `<b>① 坐标与通达</b>：${nRoute}/${D.pois.length} 个点位的步行距离与用时来自 OSRM 步行路网实测
     （<b>不是直线距离</b>），其余为直线×1.35 估算，面板里标「直线」以示区别。`,
    `<b>② 断电后可用性</b>：这是按类别判定的<b>推断值，不是实测</b>。加油站油泵、超市 POS、电梯、
     门禁断电即失效——图标画上去不等于能用。勾「只看断电后仍可用」，${nOk}/${D.pois.length} 个点位会留下。`,
    `<b>③④ 容量与备用</b>：容量是量级粗估，用于排序而非精确计划；备用方案自动给同类第二近点，
     详情面板里点名字可直接跳过去。`,
    `<b>⑤ 核实时间</b>：全部为 ${D.meta.generated || "OSM 快照"}，<b>无一经过实地踏勘</b>。
     地图会过期，没有时间戳的图不可信——做任何实地决策前必须现场核实。`,
    `<b>垂直维度</b>：楼层、屋顶可集雨面积、地下停车空间已进详情面板；≥8 层标注电梯停运后的运补困难，
     ≥15 层提示可能有避难层（需现场确认）。平面路况好不等于高层能用。`,
    `<b>人本身</b>：勾「人群密度着色」按估算人口给建筑上色；小区出入口、地铁、学校单列一类。
     灾时最大的变量是人群流动，不是资源分布——撤离瓶颈常在出入口与楼梯。`,
    `<b>底图与坐标</b>：底图 © 高德地图（JS API，GCJ-02）；建筑轮廓、道路、POI 来自 OpenStreetMap
     （Overpass API，ODbL 1.0），数据同样按 GCJ-02 存储，<b>与底图一致、无需换算</b>。`,
    `<b>已知缺口</b>：OSM 在城区的 POI 与门牌覆盖不完整（楼号仅 ${D.pois.filter((p) => p.hn).length}/${D.pois.length} 个点位有），
     水厂泵站、AED、低洼洪水区等类别是<b>几何推算或类别推断</b>，不是实测。这不是一张可执行的图，是一张待现场核实的底稿。`
  ].map((s) => `<li>${s}</li>`).join("");

  el("brand-sub").textContent =
    `DEMO — ${D.meta.area || "北苑片区"} · ${D.pois.length} 个资源点 / ` +
    `${(D.roads || []).length} 条撤离道路 / ${(D.chokes || []).length} 个桥隧卡点 / ` +
    `${D.buildings.length} 栋建筑`;

  /* ==========================================================
   * 首次使用引导
   * 被测用户（含录屏）反馈：打开后「不知道这是个什么东西」「不知道咋弄」。
   * 首屏自动弹四步说明，看过一次不再弹；顶栏「使用说明」可随时重开。
   * ========================================================== */
  const OB_STEPS = [
    { t: "这是什么",
      h: `<p>北苑片区的<b>生存资源底稿</b>：水、食物、医疗、能源通信、撤离路线、危险源、据点、
           可种地共 <b>8 类资源点位</b>，外加灰色建筑轮廓与紫色候选地块。</p>
          <p class="ob-warn">它<b>不是可执行地图</b>——数据来自 OpenStreetMap 众包，
             <b>无一处经过实地踏勘</b>。做任何实地决策前必须现场核实。</p>` },
    { t: "怎么看一个点",
      h: `<p>地图上每个点默认只显示<b>一枚单字图标</b>（水／食／医／电／撤／危／住／种）。
             <b>点一下</b>展开它的信息卡，再点一下收起。</p>
          <p>信息卡里有：步行距离与用时、断电后能不能用、容量量级、最近的备用点、
             OSM 原始对象链接（可自己核查）。</p>
          <p>紫色多边形是<b>候选地块</b>，点它看采光评分、面积与作物产能。</p>` },
    { t: "怎么筛",
      h: `<p>左侧<b>资源图层</b>里点任意一行即可开关该图层；下面的
             <b>「只看生存必需」</b>一键只留水／食物／医疗／能源／据点。</p>
          <p><b>「人群」一类有 68 个灰点、占了全图近一半，默认关闭</b>，需要时点开。</p>
          <p>「断电可用性筛选」勾上后只剩断电后仍能用的点位——这一刀通常砍掉一半。</p>` },
    { t: "怎么移动",
      h: `<p>滚轮 / 双击 = 缩放，按住拖动 = 平移，右下角 <b>＋ －</b> 也能缩放。</p>
          <p>迷路了点右上角<b>「重置视角」</b>回到片区全景。</p>
          <p>随时点顶栏<b>「使用说明」</b>重新打开这段说明。</p>` }
  ];
  let obIdx = 0;
  function obRender() {
    const s = OB_STEPS[obIdx];
    el("ob-title").textContent = s.t;
    el("ob-idx").textContent = (obIdx + 1) + " / " + OB_STEPS.length;
    el("ob-body").innerHTML = s.h;
    el("ob-prev").style.visibility = obIdx === 0 ? "hidden" : "visible";
    el("ob-next").textContent = obIdx === OB_STEPS.length - 1 ? "开始使用" : "下一步";
  }
  function obOpen() { obIdx = 0; obRender(); el("onboard").classList.remove("hidden"); }
  function obClose() {
    el("onboard").classList.add("hidden");
    try { localStorage.setItem("pm_onboarded", "1"); } catch (e) {}
  }
  function bindOnboard() {
    el("ob-next").addEventListener("click", () => {
      if (obIdx >= OB_STEPS.length - 1) return obClose();
      obIdx++; obRender();
    });
    el("ob-prev").addEventListener("click", () => { if (obIdx > 0) { obIdx--; obRender(); } });
    el("ob-skip").addEventListener("click", obClose);
    el("btn-guide").addEventListener("click", obOpen);
    el("onboard").addEventListener("click", (e) => { if (e.target.id === "onboard") obClose(); });
    let seen = null;
    try { seen = localStorage.getItem("pm_onboarded"); } catch (e) {}
    if (!seen) obOpen();
  }

  /* ---------------- 启动 ---------------- */
  bindKeyPanel();
  bindOnboard();
  if (location.protocol === "file:") {
    const w = document.getElementById("file-warning");
    if (w) w.style.display = "block";
  }
  applyMouseSens(state.sens);
  buildLegend();
  refreshVisibility();
  setView("top");            // 默认二维正射，跟手机/苹果地图一致
  el("viewmode").value = "top";
  updateHud();
  el("loading").classList.add("hidden");
})();
