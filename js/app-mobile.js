/* ==========================================================
 * 手机版逻辑：全屏二维地图 + 稀疏单字图标 + 底部抽屉
 * 设计原则：
 *   - 默认二维（viewMode:'2D'），不倾斜、不三维，跟苹果地图一致
 *   - 每个资源点默认只显示一枚单字彩色图标，不铺文字，不遮地图
 *   - 点图标 → 底部抽屉展开详情；收起抽屉 → 回到图例
 * ========================================================== */
(function () {
  "use strict";

  const D = window.BEIYUAN;
  const loading = document.getElementById("m-loading");

  function fail(msg) {
    loading.classList.remove("hidden");
    loading.textContent = msg;
  }

  if (!D) { fail("数据加载失败：找不到 BEIYUAN"); return; }
  if (typeof AMap === "undefined") {
    fail("高德地图 JS API 未加载。请检查 Key 是否有效、域名是否在高德后台白名单内。");
    return;
  }

  const CATS = D.cats;
  const ORDER = D.cat_order || Object.keys(CATS);
  const SUB_ZH = D.sub_zh || {};
  const PW_TEXT = { ok: "断电可用", part: "断电受限", no: "断电失效", na: "避开" };
  const PW_COLOR = { ok: "#16a34a", part: "#f59e0b", no: "#dc2626", na: "#94a3b8" };
  const BUILD_COLOR = {
    residential: "#e6e3dc", apartments: "#e6e3dc", house: "#eae7e0",
    commercial: "#dfe3e9", retail: "#dfe3e9", office: "#dde2e9",
    industrial: "#e4e1d8", warehouse: "#e7e4dc",
    school: "#e6e4e8", hospital: "#e9e3e6", hotel: "#e0e5ec", yes: "#e5e2db"
  };

  const center = D.meta && D.meta.center ? D.meta.center : [116.4272, 40.0334];

  /* ---------------- 地图 ---------------- */
  const map = new AMap.Map("map", {
    zoom: 16,
    center: center,
    viewMode: "2D",
    pitch: 0,
    rotation: 0,
    showLabel: true,
    resizeEnable: true,
    zooms: [12, 19],
    mapStyle: "amap://styles/normal"
  });

  /* ---------------- 建筑轮廓：默认关闭，点按钮才画 ---------------- */
  let buildPolys = null;
  function buildBuildings() {
    if (buildPolys) return buildPolys;
    buildPolys = [];
    (D.buildings || []).forEach((b) => {
      const ring = b.r || [];
      if (ring.length < 8) return;
      const path = [];
      for (let i = 0; i < ring.length; i += 2) path.push([ring[i], ring[i + 1]]);
      const poly = new AMap.Polygon({
        path: path,
        fillColor: BUILD_COLOR[b.t] || BUILD_COLOR.yes,
        fillOpacity: 0.42,
        strokeColor: "#a8a49b",
        strokeWeight: 1,
        strokeOpacity: 0.8,
        zIndex: 20
      });
      buildPolys.push(poly);
    });
    return buildPolys;
  }
  function setBuildings(on) {
    const arr = buildBuildings();
    arr.forEach((p) => (on ? p.setMap(map) : p.setMap(null)));
  }

  /* ---------------- 资源点图标 ---------------- */
  const items = [];               // { p, mk, el }
  const hidden = new Set();       // 被关掉的类别
  let selected = null;

  function pinEl(cat, isSel) {
    const el = document.createElement("div");
    el.className = "pm-pin" + (isSel ? " sel" : "");
    el.style.setProperty("--pc", cat.color);
    el.textContent = cat.icon || "?";
    return el;
  }

  D.pois.forEach((p) => {
    const cat = CATS[p.c] || { color: "#64748b", icon: "?", zh: p.c };
    const el = pinEl(cat, false);
    const mk = new AMap.Marker({
      position: [p.x, p.y],
      content: el,
      offset: new AMap.Pixel(-13, -13),
      zIndex: 100,
      extData: p,
      cursor: "pointer"
    });
    mk.on("click", () => select(p, mk));
    mk.setMap(map);
    items.push({ p: p, mk: mk, el: el, cat: cat });
  });

  function applyFilter() {
    items.forEach((it) => {
      const on = !hidden.has(it.p.c);
      if (on) it.mk.setMap(map); else it.mk.setMap(null);
    });
    renderChips();
    renderLegend();
  }

  /* ---------------- 顶部类别 chips ---------------- */
  const chipsBox = document.getElementById("m-chips");
  function renderChips() {
    chipsBox.innerHTML = "";
    ORDER.forEach((k) => {
      const cat = CATS[k];
      if (!cat) return;
      const n = D.pois.filter((p) => p.c === k).length;
      if (!n) return;
      const d = document.createElement("div");
      d.className = "m-chip" + (hidden.has(k) ? " off" : "");
      d.innerHTML = '<i style="background:' + cat.color + '"></i>' + cat.zh + " " + n;
      d.addEventListener("click", () => {
        if (hidden.has(k)) hidden.delete(k); else hidden.add(k);
        applyFilter();
      });
      chipsBox.appendChild(d);
    });
  }

  /* ---------------- 底部抽屉 ---------------- */
  const sheet = document.getElementById("m-sheet");
  const handle = document.getElementById("m-handle");
  const hint = document.getElementById("m-hint");
  const body = document.getElementById("m-body");
  const legendBox = document.getElementById("m-legend");
  const detailBox = document.getElementById("m-detail");

  function openSheet() { sheet.classList.remove("collapsed"); }
  function collapseSheet() { sheet.classList.add("collapsed"); }

  handle.addEventListener("click", () => {
    if (sheet.classList.contains("collapsed")) openSheet();
    else collapseSheet();
  });

  document.getElementById("m-switch").addEventListener("click", (e) => {
    e.stopPropagation();
    try { localStorage.removeItem("pm_device"); } catch (err) {}
    location.href = "index.html";
  });

  function renderLegend() {
    legendBox.innerHTML = "";
    const tip = document.createElement("div");
    tip.style.cssText = "grid-column:1/-1;font-size:12px;color:#8b93a1;line-height:1.6;margin-bottom:2px";
    tip.innerHTML = "地图上每个点默认只显示<b>一枚单字图标</b>，点它才展开详情。"
      + "「危险源」= 化工 / 油库 / 变电站等潜在风险源，不是「危险地点」；"
      + "公交场站、住宅小区、地铁站已从该类中剔除。";
    legendBox.appendChild(tip);
    ORDER.forEach((k) => {
      const cat = CATS[k];
      if (!cat) return;
      const n = D.pois.filter((p) => p.c === k).length;
      if (!n) return;
      const d = document.createElement("div");
      d.className = "m-lg" + (hidden.has(k) ? " off" : "");
      d.innerHTML = '<i style="background:' + cat.color + '">' + cat.icon + '</i>'
        + '<span class="ln">' + cat.zh + '</span><span class="lc">' + n + '</span>';
      d.addEventListener("click", () => {
        if (hidden.has(k)) hidden.delete(k); else hidden.add(k);
        applyFilter();
      });
      legendBox.appendChild(d);
    });
  }

  function row(k, v) {
    return '<div class="m-row"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';
  }

  function select(p, mk) {
    selected = p;
    items.forEach((it) => it.el.classList.remove("sel"));
    if (mk) {
      const it = items.filter((x) => x.mk === mk)[0];
      if (it) it.el.classList.add("sel");
    }
    const cat = CATS[p.c] || { zh: p.c, icon: "?", color: "#64748b" };
    const sub = SUB_ZH[p.sub] || p.sub || "";
    let h = '<h3>' + (p.n || cat.zh) + '</h3>';
    h += '<div class="m-sub">' + cat.zh + (sub ? " · " + sub : "") + '</div>';

    const pw = p.pw || "na";
    h += row("断电可用性",
      '<span class="pwtag ' + pw + '">' + (PW_TEXT[pw] || "—") + '</span>');
    if (p.d != null) {
      const src = p.dsrc === "route" ? "路网实测" : "直线估算";
      h += row("步行距离", p.d + " m · " + (p.t != null ? p.t + " 分钟" : "—")
        + '<br><span style="font-size:11px;color:#8b93a1">' + src + '</span>');
    }
    if (p.cap) h += row("容量 / 存量", p.cap);
    if (p.pwr) h += '<div class="m-note">' + p.pwr + '</div>';
    if (p.fb && p.fb.n) {
      h += row("备用方案", p.fb.n + "<br><span style='font-size:11px;color:#8b93a1'>"
        + (p.fb.d != null ? p.fb.d + " m" : "") + '</span>');
    }
    h += '<div class="m-actions">'
      + '<button class="btn" id="m-back">收起</button>'
      + '<button class="btn pri" id="m-center">居中</button>'
      + '</div>';

    detailBox.innerHTML = h;
    detailBox.hidden = false;
    legendBox.style.display = "none";
    hint.textContent = p.n || cat.zh;
    openSheet();

    document.getElementById("m-back").addEventListener("click", () => {
      detailBox.hidden = true;
      legendBox.style.display = "";
      hint.textContent = "点击地图上的图标查看详情";
      if (selected) {
        const it = items.filter((x) => x.p === selected)[0];
        if (it) it.el.classList.remove("sel");
      }
      selected = null;
      collapseSheet();
    });
    document.getElementById("m-center").addEventListener("click", () => {
      map.setZoomAndCenter(17.5, [p.x, p.y]);
    });
  }

  /* ---------------- 搜索 ---------------- */
  const sInput = document.getElementById("m-search");
  const sClear = document.getElementById("m-clear");
  const hitsBox = document.getElementById("m-hits");

  function renderHits(q) {
    const key = (q || "").trim();
    if (!key) { hitsBox.hidden = true; hitsBox.innerHTML = ""; sClear.hidden = true; return; }
    sClear.hidden = false;
    const hits = D.pois.filter((p) => (p.n || "").indexOf(key) >= 0).slice(0, 20);
    if (!hits.length) {
      hitsBox.hidden = false;
      hitsBox.innerHTML = '<div class="m-hit"><span class="hn" style="color:#8b93a1">没有找到「' + key + '」</span></div>';
      return;
    }
    hitsBox.innerHTML = "";
    hits.forEach((p) => {
      const cat = CATS[p.c] || { color: "#94a3b8", zh: p.c };
      const d = document.createElement("div");
      d.className = "m-hit";
      d.innerHTML = '<i style="background:' + cat.color + '"></i>'
        + '<span class="hn">' + (p.n || cat.zh) + '</span>'
        + '<span class="hd">' + cat.zh + (p.d != null ? " · " + p.d + "m" : "") + '</span>';
      d.addEventListener("click", () => {
        hitsBox.hidden = true;
        sInput.value = "";
        sClear.hidden = true;
        map.setZoomAndCenter(17.5, [p.x, p.y]);
        const it = items.filter((x) => x.p === p)[0];
        select(p, it ? it.mk : null);
      });
      hitsBox.appendChild(d);
    });
    hitsBox.hidden = false;
  }

  sInput.addEventListener("input", () => renderHits(sInput.value));
  sClear.addEventListener("click", () => { sInput.value = ""; renderHits(""); });

  /* ---------------- 浮动按钮 ---------------- */
  document.getElementById("m-locate").addEventListener("click", () => {
    map.setZoomAndCenter(16, center);
  });

  const tiltBtn = document.getElementById("m-tilt");
  let tilted = false;
  tiltBtn.addEventListener("click", () => {
    tilted = !tilted;
    map.setPitch(tilted ? 55 : 0);
    tiltBtn.classList.toggle("on", tilted);
    tiltBtn.textContent = tilted ? "2D" : "3D";
  });

  const buildBtn = document.getElementById("m-build");
  let buildOn = false;
  buildBtn.addEventListener("click", () => {
    buildOn = !buildOn;
    setBuildings(buildOn);
    buildBtn.classList.toggle("on", buildOn);
  });

  /* ---------------- 启动 ---------------- */
  renderChips();
  renderLegend();
  applyFilter();
  map.on("complete", () => loading.classList.add("hidden"));
  setTimeout(() => loading.classList.add("hidden"), 1200);
})();
