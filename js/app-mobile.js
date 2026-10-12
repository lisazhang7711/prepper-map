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
  /* 「人群」一类有 68 个灰点、占全图近一半，首屏看不出重点 —— 默认关闭 */
  const hidden = new Set(D.pois.filter((p) => p.c === "people").length > 30 ? ["people"] : []);
  let selected = null;

  /* 人群密度：与电脑版同口径 —— 当量人数折算 0-100 分，浅红人少 → 深红人多，点也更大 */
  function peopleDens(p) {
    if (p.sub === "metro") return 1200;
    if (p.sub === "mall") return 1500;
    if (p.sub === "school") {
      const s = p.n || "";
      if (/幼儿园|幼稚园/.test(s)) return 260;
      if (/小学/.test(s)) return 900;
      if (/中学|初中|高中/.test(s)) return 1600;
      if (/大学|学院/.test(s)) return 1800;
      if (/国际|双语/.test(s)) return 1100;
      return 900;
    }
    let best = null, bd = 1e9;
    (D.buildings || []).forEach((b) => {
      if (b.cx == null || b.cy == null || !b.pop) return;
      const dx = (b.cx - p.x) * 111320 * Math.cos(p.y * Math.PI / 180);
      const dy = (b.cy - p.y) * 111320;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bd) { bd = d; best = b; }
    });
    if (best && bd <= 90) return best.pop;
    const m = /地上\s*(\d+)\s*层/.exec(p.vt || "");
    const lv = p.lv || (m ? +m[1] : 0);
    return lv ? Math.round(lv * 4 * 2.8) : 160;
  }
  function densRate(n) {
    return Math.max(0, Math.min(1,
      (Math.log(Math.max(n, 30)) - Math.log(60)) / (Math.log(3000) - Math.log(60))));
  }
  /* 人群一律类目灰：灰的深浅与人口密度无关，密度只体现在圆点大小 */
  function densCol() {
    return (CATS.people && CATS.people.color) || "#475569";
  }

  function pinEl(cat, isSel, col, sc) {
    const el = document.createElement("div");
    el.className = "pm-pin" + (isSel ? " sel" : "");
    el.style.setProperty("--pc", col || cat.color);
    if (sc != null && !isSel) {           /* 人越多点越大：24 ~ 32 px */
      const w = Math.round(24 + 8 * sc);
      el.style.width = el.style.height = w + "px";
      el.style.lineHeight = (w - 4) + "px";
      el.style.fontSize = (w >= 29 ? 15 : 13) + "px";
    }
    el.textContent = cat.icon || "?";
    return el;
  }

  D.pois.forEach((p) => {
    const cat = CATS[p.c] || { color: "#64748b", icon: "?", zh: p.c };
    const dn = p.c === "people" ? peopleDens(p) : null;
    const el = pinEl(cat, false, dn ? densCol(dn) : null, dn ? densRate(dn) : null);
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

  let hideStale = true;   // 隐藏「OSM+高德都查不到」的疑似已关闭点位

  function applyFilter() {
    items.forEach((it) => {
      const on = !hidden.has(it.p.c) && !(hideStale && it.p._v === "dead");
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
      const swg = 'background:' + cat.color;
      d.innerHTML = '<i style="' + swg + '"></i>' + cat.zh + " " + n;
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
      const sw2 = 'background:' + cat.color;
    d.innerHTML = '<i style="' + sw2 + '">' + cat.icon + '</i>'
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

  /* 数据纠错：复制一条结构化反馈 */
  function copyTextM(s) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(s);
        return;
      }
    } catch (e) {}
    try {
      var ta = document.createElement("textarea");
      ta.value = s;
      ta.style.cssText = "position:fixed;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (e) {}
  }

  function ckHtml(p) {
    const MAP = {
      ok:   ["ok",   "两处数据源都能查到"],
      warn: ["warn", "位置在但名称对不上，可能换了商户"],
      dead: ["dead", "OSM 与高德都查不到，疑似已关闭 / 搬走"],
      unk:  ["unk",  "设施型点位，无法自动核验"]
    };
    const v = MAP[p._v] || MAP.unk;
    let s = '<span class="ck ' + v[0] + '">' + v[1] + '</span>';
    if (p.amn) s += '<br><span style="font-size:11px;color:#8b93a1">高德收录名：' + p.amn + '</span>';
    const osmTxt = p.osm === "gone" ? "已删除" : (p.osm === "unknown" ? "未查到" : "仍在");
    const amTxt = p.am === "alive" ? "有" : (p.am === "gone" ? "查无" : (p.am === "renamed" ? "名称不同" : "未判定"));
    s += '<br><span style="font-size:11px;color:#8b93a1">交叉核验 ' + (p.ck || "—")
       + ' ｜ OSM ' + osmTxt + ' ｜ 高德 ' + amTxt + '</span>';
    return s;
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
    h += row("数据核验", ckHtml(p));
    h += '<div class="m-rpt"><span>这里不对？</span>'
      + '<button class="m-rptb" data-rpt="gone">已拆除 / 搬走</button>'
      + '<button class="m-rptb" data-rpt="wrong">信息有误</button>'
      + '<div class="m-rpts">点一下会复制一条反馈，发给我就能改数据</div></div>';

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
    detailBox.querySelectorAll(".m-rptb").forEach(function (b) {
      b.addEventListener("click", function () {
        var kind = b.dataset.rpt === "gone" ? "已拆除 / 搬走" : "信息有误";
        var txt = "[" + kind + "] " + (p.i || "-") + " | " + (p.n || "-") + " | "
          + p.c + (p.sub ? "/" + p.sub : "") + " | " + new Date().toISOString().slice(0, 10);
        copyTextM(txt);
        try {
          var arr = JSON.parse(localStorage.getItem("pm_report") || "[]");
          arr.push(txt);
          localStorage.setItem("pm_report", JSON.stringify(arr));
        } catch (e) {}
        var old = b.textContent;
        b.textContent = "已复制 ✓";
        setTimeout(function () { b.textContent = old; }, 2000);
      });
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

  const staleBtn = document.getElementById("m-stale");
  if (staleBtn) {
    const nDead = D.pois.filter((p) => p._v === "dead").length;
    staleBtn.title = "隐藏疑似已关闭（" + nDead + " 个）";
    staleBtn.style.display = nDead ? "" : "none";   // 没有已关闭点位时隐藏这个按钮
    staleBtn.classList.toggle("on", hideStale);
    staleBtn.addEventListener("click", () => {
      hideStale = !hideStale;
      staleBtn.classList.toggle("on", hideStale);
      applyFilter();
    });
  }

  /* ---------------- 缩放按钮 ---------------- */
  const zin = document.getElementById("m-zin"), zout = document.getElementById("m-zout");
  if (zin) zin.addEventListener("click", () => map.setZoom(Math.min(19, map.getZoom() + 1)));
  if (zout) zout.addEventListener("click", () => map.setZoom(Math.max(12, map.getZoom() - 1)));

  /* ---------------- 首次使用引导 ----------------
   * 录屏用户反馈：打开后不知道这是个什么东西，得自己摸索。首屏三步说明。 */
  const MOB_STEPS = [
    { t: "这是什么",
      h: "<p>北苑片区的<b>生存资源底稿</b>：水、食物、医疗、能源通信、撤离路线、"
       + "危险源、据点、可种地，共 8 类点位。</p>"
       + "<p class='m-ob-warn'>它<b>不是可执行地图</b>——数据来自 OpenStreetMap 众包，"
       + "无一经过实地踏勘，实地决策前必须现场核实。</p>" },
    { t: "怎么看一个点",
      h: "<p>地图上每个点是一枚<b>单字图标</b>（水／食／医／电／撤／危／住／种），"
       + "<b>点一下</b>看详情，详情在底部抽屉里，往上拖可展开。</p>"
       + "<p>底部<b>图例</b>可开关类别；「人群」一类点太多，默认关闭。</p>" },
    { t: "怎么移动",
      h: "<p>双指捏合或右侧 <b>＋ －</b> 缩放，单指拖动平移。</p>"
       + "<p>迷路了点 <b>◎</b> 回到片区中心，点 <b>?</b> 可重看本说明。</p>" }
  ];
  let mobIdx = 0;
  const obEl = document.getElementById("m-onboard");
  function mobRender() {
    const s = MOB_STEPS[mobIdx];
    document.getElementById("m-ob-t").textContent = s.t;
    document.getElementById("m-ob-i").textContent = (mobIdx + 1) + " / " + MOB_STEPS.length;
    document.getElementById("m-ob-b").innerHTML = s.h;
    document.getElementById("m-ob-next").textContent =
      mobIdx === MOB_STEPS.length - 1 ? "开始使用" : "下一步";
  }
  function mobOpen() { mobIdx = 0; mobRender(); obEl.classList.remove("hidden"); }
  function mobClose() {
    obEl.classList.add("hidden");
    try { localStorage.setItem("pm_onboarded_m", "1"); } catch (e) {}
  }
  if (obEl) {
    document.getElementById("m-ob-next").addEventListener("click", () => {
      if (mobIdx >= MOB_STEPS.length - 1) return mobClose();
      mobIdx++; mobRender();
    });
    document.getElementById("m-ob-skip").addEventListener("click", mobClose);
    obEl.addEventListener("click", (e) => { if (e.target === obEl) mobClose(); });
    const gb = document.getElementById("m-guide");
    if (gb) gb.addEventListener("click", mobOpen);
    let seen = null;
    try { seen = localStorage.getItem("pm_onboarded_m"); } catch (e) {}
    if (!seen) mobOpen();
  }

  /* ---------------- 启动 ---------------- */
  renderChips();
  renderLegend();
  applyFilter();
  map.on("complete", () => loading.classList.add("hidden"));
  setTimeout(() => loading.classList.add("hidden"), 1200);
})();
