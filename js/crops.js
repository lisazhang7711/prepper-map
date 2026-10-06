/* 作物库：用于「可种植地块」的产能估算。
 * 数值为华北平原露天种植条件下的常用参考中值，非精算；
 * kcal 按可食部计，用于对比不同作物的单位面积供能效率。
 */
window.CROPS = [
  {
    k: "sweetpotato", zh: "红薯（甘薯）", en: "Sweet potato", pri: 1,
    days: 130, kcalKg: 860, kgM2: 3.0, seasons: 1, store: 7, hardy: 5, water: 3,
    seedNote: "不用种子：留种薯育苗，或用薯块直接扦插，可年复一年自留种",
    tip: "单位面积供能最高的粗放作物，耐旱耐贫瘠，病虫害少。收获后需愈合伤口 + 13~16℃ 窖藏，否则易烂。" +
         "藤蔓嫩叶也是可食叶菜，生长期可分批采摘。"
  },
  {
    k: "corn", zh: "玉米", en: "Maize", pri: 1,
    days: 110, kcalKg: 3650, kgM2: 0.75, seasons: 1, store: 14, hardy: 4, water: 3,
    seedNote: "市售杂交种 F2 会严重退化，长期自给应预留常规种或农家种",
    tip: "单位面积每季产出热量最高，籽粒干燥后可长期储存，还能磨粉做饼。缺点：需足量与 wind 授粉（密植成行）、" +
         "抽雄期不耐旱，且占用土地面积大。"
  },
  {
    k: "potato", zh: "马铃薯", en: "Potato", pri: 1,
    days: 100, kcalKg: 770, kgM2: 2.2, seasons: 2, store: 5, hardy: 4, water: 4,
    seedNote: "切块带芽眼播种，可自留种；连作易累积病害，需轮作",
    tip: "华北可春、秋两茬。喜冷凉，块茎形成期怕高温（>25℃ 明显减产）。必须全程培土避免块茎见光变青产生龙葵素，储存在避光低温处。"
  },
  {
    k: "sunflower", zh: "向日葵", en: "Sunflower", pri: 2,
    days: 110, kcalKg: 5840, kgM2: 0.30, seasons: 1, store: 10, hardy: 5, water: 2,
    seedNote: "常规种可留种；鸟害严重需防鸟网",
    tip: "极耐旱、耐盐碱，油料 + 蛋白双高，是唯一的本土「油」来源。籽实含油约 45%，可补油脂缺口。"
  },
  {
    k: "peanut", zh: "花生", en: "Peanut", pri: 2,
    days: 135, kcalKg: 5670, kgM2: 0.35, seasons: 1, store: 8, hardy: 4, water: 3,
    seedNote: "带壳留种，发芽率保持一年左右",
    tip: "能量密度最高的旱地作物之一，同时解决油脂与蛋白。沙壤土产量显著更好；收获后必须彻底干燥至 8% 含水量以下，" +
         "否则黄曲霉风险。"
  },
  {
    k: "soybean", zh: "大豆", en: "Soybean", pri: 2,
    days: 115, kcalKg: 4460, kgM2: 0.28, seasons: 1, store: 18, hardy: 4, water: 3,
    seedNote: "常规种，极易自留种",
    tip: "唯一能同时补蛋白与必需脂肪酸的大田作物，且根瘤固氮、养地。可发豆芽，解决长期缺菜的维生素 C 缺口。"
  },
  {
    k: "buckwheat", zh: "荞麦", en: "Buckwheat", pri: 3,
    days: 70, kcalKg: 3430, kgM2: 0.25, seasons: 2, store: 12, hardy: 5, water: 2,
    seedNote: "常规种，自留种稳定",
    tip: "救荒 / 填闲作物：70 天即可收，几乎不挑地，可作前茬失败后的补种。产量偏低。"
  },
  {
    k: "mungbean", zh: "绿豆 / 豇豆", en: "Mung bean", pri: 3,
    days: 70, kcalKg: 3470, kgM2: 0.20, seasons: 2, store: 18, hardy: 5, water: 2,
    seedNote: "自花授粉，自留种稳定",
    tip: "耐旱、周期短、固氮，干豆储存期极长。发绿豆芽只需 5~7 天，是长期断季时的维生素来源。"
  },
  {
    k: "pumpkin", zh: "南瓜 / 笋瓜", en: "Pumpkin / Squash", pri: 3,
    days: 110, kcalKg: 260, kgM2: 3.0, seasons: 1, store: 5, hardy: 5, water: 3,
    seedNote: "常规种，留种容易但同属异种间易串粉，需隔离",
    tip: "管理粗放，产量稳定，含水量高所以热值低，但完整瓜常温可放数月，是「冬季新鲜食物」来源。可爬藤上墙节省地面。"
  },
  {
    k: "cabbage", zh: "大白菜", en: "Chinese cabbage", pri: 3,
    days: 70, kcalKg: 160, kgM2: 5.5, seasons: 1, store: 3, hardy: 4, water: 5,
    seedNote: "需年年购杂交种，自留困难",
    tip: "秋冬主栽，耐短期轻霜，热量低但产量大、可作冬储主菜。需水量高。"
  },
  {
    k: "radish", zh: "白萝卜", en: "Radish", pri: 4,
    days: 60, kcalKg: 180, kgM2: 4.0, seasons: 2, store: 3, hardy: 4, water: 4,
    seedNote: "常规种可留种（需隔离）",
    tip: "周期最短的根菜，60 天可收，适合填闲与心理安抚（有「新鲜菜」吃）。高维 C。"
  },
  {
    k: "kangkong", zh: "空心菜（蕹菜）", en: "Water spinach", pri: 4,
    days: 30, kcalKg: 220, kgM2: 1.2, seasons: 3, store: 0, hardy: 3, water: 5,
    seedNote: "春季购一次种，可多年留",
    tip: "最快 的叶菜：掐尖采收可反复多茬，夏秋生长极快。不耐储，解决的是当下的维生素与膳食纤维。"
  }
];

window.CROP_META = {
  kcalPerAdult: 2100,      // 轻体力成年人日均热量基准
  kcalMinimal: 1500,       // 静息维持下限
  usableRatio: 0.70,       // 垄沟、步道、边角折减后可实际耕作的比例
  frostFreeDays: 195       // 北京平原区无霜期约 190~200 天
};
