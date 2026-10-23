// Resorts that ship with the app as offline data packs. Everything else comes
// from OpenStreetMap at runtime. `match` is tested against OpenSkiData ski area
// names; `near` and `km` keep the match to the right valley.
export const RESORTS = [
  // New England and New York
  { slug: 'stowe', group: 'ne', en: 'Stowe', zh: '斯托', match: /^Stowe Mountain/, near: [-72.78, 44.53], km: 8 },
  { slug: 'smugglers-notch', group: 'ne', en: "Smugglers' Notch", zh: '走私者峡谷', match: /Smugglers/, near: [-72.79, 44.58], km: 8 },
  { slug: 'jay-peak', group: 'ne', en: 'Jay Peak', zh: '杰伊峰', match: /^Jay Peak/, near: [-72.50, 44.93], km: 10 },
  { slug: 'sugarbush', group: 'ne', en: 'Sugarbush', zh: '糖丛', match: /^Sugarbush/, near: [-72.90, 44.14], km: 10 },
  { slug: 'mad-river-glen', group: 'ne', en: 'Mad River Glen', zh: '疯河谷', match: /^Mad River Glen/, near: [-72.92, 44.20], km: 10 },
  { slug: 'killington', group: 'ne', en: 'Killington & Pico', zh: '基灵顿', match: /^(Killington|Pico)/, near: [-72.80, 43.63], km: 12 },
  { slug: 'okemo', group: 'ne', en: 'Okemo', zh: '奥克莫', match: /^Okemo/, near: [-72.72, 43.40], km: 10 },
  { slug: 'stratton', group: 'ne', en: 'Stratton', zh: '斯特拉顿', match: /^Stratton/, near: [-72.91, 43.11], km: 10 },
  { slug: 'mount-snow', group: 'ne', en: 'Mount Snow', zh: '雪山', match: /^Mount Snow/, near: [-72.92, 42.96], km: 10 },
  { slug: 'sugarloaf', group: 'ne', en: 'Sugarloaf', zh: '糖面包山', match: /^Sugarloaf/, near: [-70.31, 45.05], km: 10 },
  { slug: 'sunday-river', group: 'ne', en: 'Sunday River', zh: '星期日河', match: /^Sunday River/, near: [-70.86, 44.47], km: 10 },
  { slug: 'cannon', group: 'ne', en: 'Cannon', zh: '加农山', match: /^Cannon/, near: [-71.70, 44.16], km: 10 },
  { slug: 'loon', group: 'ne', en: 'Loon', zh: '潜鸟山', match: /^Loon/, near: [-71.63, 44.04], km: 10 },
  { slug: 'whiteface', group: 'ne', en: 'Whiteface', zh: '白面山', match: /^Whiteface/, near: [-73.90, 44.36], km: 10 },
  { slug: 'gore', group: 'ne', en: 'Gore', zh: '戈尔山', match: /^Gore/, near: [-74.01, 43.67], km: 10 },
  { slug: 'hunter', group: 'ne', en: 'Hunter', zh: '亨特山', match: /^Hunter/, near: [-74.23, 42.20], km: 10 },
  { slug: 'jiminy-peak', group: 'ne', en: 'Jiminy Peak', zh: '吉米尼峰', match: /^Jiminy/, near: [-73.29, 42.56], km: 10 },
  { slug: 'mohawk', group: 'ne', en: 'Mohawk Mountain', zh: '莫霍克山', match: /^Mohawk/, near: [-73.31, 41.84], km: 10 },
  { slug: 'tremblant', group: 'ne', en: 'Tremblant', zh: '翠湖', match: /Tremblant/, near: [-74.59, 46.21], km: 10 },

  // The West
  { slug: 'jackson-hole', group: 'west', en: 'Jackson Hole', zh: '杰克逊霍尔', match: /^Jackson Hole/, near: [-110.85, 43.59], km: 10 },
  { slug: 'big-sky', group: 'west', en: 'Big Sky', zh: '大天空', match: /^Big Sky/, near: [-111.40, 45.28], km: 12 },
  { slug: 'alta-snowbird', group: 'west', en: 'Alta & Snowbird', zh: '阿尔塔 / 雪鸟', match: /^(Alta|Snowbird)/, near: [-111.65, 40.58], km: 6 },
  { slug: 'park-city', group: 'west', en: 'Park City', zh: '帕克城', match: /^Park City/, near: [-111.55, 40.65], km: 10 },
  { slug: 'palisades-tahoe', group: 'west', en: 'Palisades Tahoe', zh: '帕利塞兹太浩', match: /^(Palisades|Squaw|Alpine Meadows)/, near: [-120.24, 39.19], km: 10 },
  { slug: 'mammoth', group: 'west', en: 'Mammoth', zh: '猛犸山', match: /^Mammoth/, near: [-119.03, 37.63], km: 10 },
  { slug: 'aspen', group: 'west', en: 'Aspen Snowmass', zh: '阿斯彭', match: /(Aspen|Snowmass|Buttermilk)/, near: [-106.88, 39.18], km: 14 },
  { slug: 'vail', group: 'west', en: 'Vail', zh: '韦尔', match: /^Vail/, near: [-106.37, 39.61], km: 10 },
  { slug: 'telluride', group: 'west', en: 'Telluride', zh: '特柳赖德', match: /^Telluride/, near: [-107.84, 37.92], km: 10 },
  { slug: 'whistler', group: 'west', en: 'Whistler Blackcomb', zh: '惠斯勒', match: /(Whistler|Blackcomb)/, near: [-122.95, 50.09], km: 10 },
  { slug: 'revelstoke', group: 'west', en: 'Revelstoke', zh: '雷夫尔斯托克', match: /^Revelstoke Mountain/, near: [-118.16, 50.96], km: 10 },

  // The Alps
  { slug: 'chamonix', group: 'alps', en: 'Chamonix', zh: '霞慕尼', match: /(Chamonix|Grands Montets|Br[ée]vent|Fl[ée]g[èe]re|Aiguille du Midi|Balme|Le Tour|Houches)/, near: [6.87, 45.93], km: 12 },
  { slug: 'zermatt', group: 'alps', en: 'Zermatt', zh: '采尔马特', match: /(Zermatt|Matterhorn|Cervinia)/, near: [7.73, 45.98], km: 14 },
  { slug: 'verbier', group: 'alps', en: 'Verbier', zh: '韦尔比耶', match: /(Verbier|4 Vall|Quatre Vall)/, near: [7.23, 46.10], km: 12 },
  { slug: 'st-anton', group: 'alps', en: 'St. Anton', zh: '圣安东', match: /(Arlberg|St\.? ?Anton|Sankt Anton)/, near: [10.26, 47.13], km: 12 },
  { slug: 'val-disere', group: 'alps', en: "Val d'Isère & Tignes", zh: '瓦勒迪泽尔', match: /(Val d.Is[èe]re|Tignes|Espace Killy)/, near: [6.95, 45.45], km: 12 },
  { slug: 'trois-vallees', group: 'alps', en: 'Les 3 Vallées', zh: '三峡谷', match: /(3 Vall|Trois Vall|Courchevel|M[ée]ribel|Val Thorens)/, near: [6.58, 45.35], km: 16 },
  { slug: 'la-grave', group: 'alps', en: 'La Grave', zh: '拉格拉夫', match: /^La Grave/, near: [6.31, 45.05], km: 8 },
  { slug: 'engelberg', group: 'alps', en: 'Engelberg', zh: '英格堡', match: /(Engelberg|Titlis)/, near: [8.41, 46.80], km: 10 },
  { slug: 'cortina', group: 'alps', en: "Cortina d'Ampezzo", zh: '科尔蒂纳', match: /Cortina/, near: [12.14, 46.54], km: 12 },

  // Japan and Korea
  { slug: 'niseko', group: 'asia', en: 'Niseko United', zh: '二世古', match: /(Niseko|ニセコ)/, near: [140.68, 42.86], km: 10 },
  { slug: 'rusutsu', group: 'asia', en: 'Rusutsu', zh: '留寿都', match: /(Rusutsu|ルスツ)/, near: [140.90, 42.75], km: 8 },
  { slug: 'furano', group: 'asia', en: 'Furano', zh: '富良野', match: /(Furano|富良野)/, near: [142.35, 43.33], km: 10 },
  { slug: 'hakuba-happo', group: 'asia', en: 'Hakuba Happo-one', zh: '白马八方尾根', match: /(Happo|八方)/, near: [137.80, 36.70], km: 8 },
  { slug: 'yongpyong', group: 'asia', en: 'Yongpyong', zh: '龙平', match: /(Yongpyong|용평)/, near: [128.68, 37.64], km: 10 },

  // China
  { slug: 'chongli', group: 'china', en: 'Chongli (Thaiwoo, Genting, Wanlong, Fulong)', zh: '崇礼（太舞、云顶、万龙、富龙）', match: /(太舞|云顶|万龙|富龙|多乐美地|长城岭|Thaiwoo|Genting|Wanlong|Fulong)/, near: [115.38, 40.95], km: 25 },
  { slug: 'beidahu', group: 'china', en: 'Beidahu', zh: '北大湖', match: /(北大湖|Beidahu)/, near: [126.60, 43.42], km: 30 },
  { slug: 'songhuahu', group: 'china', en: 'Songhuahu', zh: '松花湖', match: /(松花湖|Songhua)/, near: [126.65, 43.70], km: 30 },
  { slug: 'changbaishan', group: 'china', en: 'Changbaishan', zh: '长白山', match: /(长白山|Changbai)/, near: [127.55, 42.10], km: 40 },
  { slug: 'yabuli', group: 'china', en: 'Yabuli', zh: '亚布力', match: /(亚布力|Yabuli)/, near: [128.47, 44.78], km: 30 },
  { slug: 'jiangjunshan', group: 'china', en: 'Jiangjunshan', zh: '将军山', match: /(将军山|Jiangjunshan)/, near: [88.12, 47.85], km: 30 },
  { slug: 'koktokay', group: 'china', en: 'Koktokay', zh: '可可托海', match: /(可可托海|Koktokay|Keketuohai)/, near: [89.80, 47.20], km: 60 },
  { slug: 'jikepulin', group: 'china', en: 'Jikepulin (Hemu)', zh: '吉克普林（禾木）', match: /(吉克普林|禾木|Jikepulin|Hemu)/, near: [87.40, 48.60], km: 60 },
];
