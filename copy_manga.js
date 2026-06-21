// ==UserScript==
// @name         拷贝漫画
// @version      1.0.0
// @author       Venera
// @description  拷贝漫画源 - copy3000.com
// ==/UserScript==

/** @type {import('./_venera_.js')} */

const DEFAULT_BASE_URL = "https://www.copy3000.com";
const CCZ = "op0zzpvv.nmn.00p";

// ============================================================
// Helpers
// ============================================================

// Convert hex string to ArrayBuffer
function hexToBytes(hex) {
    var len = hex.length;
    var result = new Uint8Array(len / 2);
    for (var i = 0; i < len; i += 2) {
        result[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return result.buffer;
}

// Decrypt AES-128-CBC: first 16 chars = IV (UTF-8), rest = hex ciphertext
// Venera's decryptAesCbc may not strip PKCS7 padding, so we do it from the string.
function decryptData(encrypted) {
    var iv = Convert.encodeUtf8(encrypted.substring(0, 16));
    var ciphertext = hexToBytes(encrypted.substring(16));
    var key = Convert.encodeUtf8(CCZ);
    var decrypted = Convert.decryptAesCbc(ciphertext, key, iv);
    var text = Convert.decodeUtf8(decrypted);

    // Strip PKCS7 padding: last byte's value = number of padding bytes
    var lastCode = text.charCodeAt(text.length - 1);
    if (lastCode >= 1 && lastCode <= 16) {
        text = text.substring(0, text.length - lastCode);
    }

    return JSON.parse(text);
}

// Fetch chapter list from encrypted API
async function fetchChapters(comicId, baseUrl) {
    var resp = await Network.get(
        baseUrl + "/comicdetail/" + encodeURIComponent(comicId) + "/chapters",
        { dnts: "3" }
    );
    var json = JSON.parse(resp.body);
    if (json.code !== 200) throw new Error(json.message);

    var data = decryptData(json.results);
    var groups = data.groups || {};
    var chapters = {};

    for (var groupKey in groups) {
        var group = groups[groupKey];
        var groupChapters = group.chapters || [];
        for (var i = 0; i < groupChapters.length; i++) {
            var ch = groupChapters[i];
            chapters[ch.id] = ch.name;
        }
    }
    return chapters;
}

// Parse the embedded list attribute from explore page HTML
// The list attribute contains a JS array literal with single-quoted strings
function parseExploreList(html) {
    var m = html.match(/list="([^"]+)"/);
    if (!m) return [];
    var raw = m[1]
        .replace(/&#x27;/g, "'")
        .replace(/&#34;/g, '"')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&");
    var json = raw.replace(/'/g, '"');
    var items = JSON.parse(json);
    return items.map(function (item) {
        return new Comic({
            id: item.path_word,
            title: item.name,
            cover: item.cover || "",
            description: item.author && item.author.length > 0 ? item.author[0].name || "" : ""
        });
    });
}

// Convert search API item to Venera Comic
function apiToComic(item) {
    var author = "";
    if (item.author && item.author.length > 0) {
        author = item.author[0].name || "";
    }
    return new Comic({
        id: item.path_word,
        title: item.name,
        cover: item.cover || "",
        description: author
    });
}

// Extract max page number from explore/listing page HTML
function parseMaxPage(html) {
    var pageMatch = html.match(/<ul[^>]*class="page-all"[^>]*>[\s\S]*?<\/ul>/);
    if (pageMatch) {
        var nums = pageMatch[0].match(/>(\d+)<\/a>/g);
        if (nums) {
            var max = 1;
            for (var i = 0; i < nums.length; i++) {
                var n = parseInt(nums[i].replace(/>|<\/a>/g, ""));
                if (!isNaN(n) && n > max) max = n;
            }
            return max;
        }
    }
    return 1;
}

// ============================================================
// Venera Source
// ============================================================

class CopyManga extends ComicSource {

    name = "拷贝漫画"

    key = "copy_manga"

    version = "1.6.0"

    minAppVersion = "1.6.0"

    url = "https://cdn.jsdelivr.net/gh/venera-app/venera-configs@main/copy_manga.js"

    init() {
        console.log("CopyManga v" + this.version + " loaded");
    }

    // Helper: generate random 6-digit salt (same as website JS)
    _genSalt() {
        return parseInt(Math.random().toString().slice(-6));
    }

    // Helper: encode password with salt (same as website JS: Base64(password + "-" + salt))
    _encodePassword(password, salt) {
        var text = password + "-" + salt;
        var bytes = Convert.encodeUtf8(text);
        return Convert.encodeBase64(bytes);
    }

    // Helper: set all cookies from login response results
    _setLoginCookies(results) {
        var cookies = [];
        var domain = ".copy3000.com";

        if (results.token) cookies.push(new Cookie({ name: "token", value: results.token, domain: domain }));
        if (results.user_id) cookies.push(new Cookie({ name: "user_id", value: results.user_id, domain: domain }));
        if (results.nickname) cookies.push(new Cookie({ name: "name", value: results.nickname, domain: domain }));
        if (results.avatar) cookies.push(new Cookie({ name: "avatar", value: results.avatar, domain: domain }));
        if (results.datetime_created) cookies.push(new Cookie({ name: "create", value: results.datetime_created, domain: domain }));
        if (results.comic_vip) cookies.push(new Cookie({ name: "comic_vip", value: String(results.comic_vip), domain: domain }));
        if (results.cartoon_vip) cookies.push(new Cookie({ name: "cartoon_vip", value: String(results.cartoon_vip), domain: domain }));

        Network.setCookies("https://www.copy3000.com", cookies);
    }

    account = {
        login: async (account, pwd) => {
            var salt = this._genSalt();
            var encodedPwd = this._encodePassword(pwd, salt);
            var baseUrl = this._baseUrl;

            var res = await Network.post(
                baseUrl + "/api/kb/web/login",
                {
                    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "platform": "2"
                },
                "username=" + encodeURIComponent(account)
                + "&password=" + encodedPwd
                + "&salt=" + salt
                + "&platform=2"
                + "&version=2025.12.10"
                + "&source=freeSite"
            );

            var json = JSON.parse(res.body);
            if (json.code === 200) {
                var results = json.results;
                this.saveData("token", results.token);
                this.saveData("user_id", results.user_id);
                this.saveData("nickname", results.nickname);

                // Set cookies for authenticated API requests
                this._setLoginCookies(results);

                return "ok";
            }

            throw json.message || "登录失败";
        },

        logout: () => {
            this.deleteData("token");
            this.deleteData("user_id");
            this.deleteData("nickname");
            Network.deleteCookies("https://www.copy3000.com");
        },

        registerWebsite: "https://www.copy3000.com/web/login/loginByAccount"
    }

    get _baseUrl() {
        return this.loadSetting("base_url") || DEFAULT_BASE_URL;
    }

    explore = [
        {
            title: "最新",
            type: "multiPageComicList",
            load: async (page) => {
                var offset = ((page || 1) - 1) * 50;
                var url = this._baseUrl + "/comics?ordering=-datetime_updated&offset=" + offset + "&limit=50";
                var resp = await Network.get(url, { dnts: "3" });
                var comics = parseExploreList(resp.body);
                return { comics: comics, maxPage: parseMaxPage(resp.body) };
            }
        },
        {
            title: "热门",
            type: "multiPageComicList",
            load: async (page) => {
                var offset = ((page || 1) - 1) * 50;
                var url = this._baseUrl + "/comics?ordering=-hits_total&offset=" + offset + "&limit=50";
                var resp = await Network.get(url, { dnts: "3" });
                var comics = parseExploreList(resp.body);
                return { comics: comics, maxPage: parseMaxPage(resp.body) };
            }
        }
    ]

    category = {
        title: "题材",
        parts: [
            {
                name: "排行",
                type: "fixed",
                categories: ["排行"],
                categoryParams: ["ranking"],
                itemType: "category",
            },
            {
                name: "分类",
                type: "fixed",
                categories: [
                    { label: "全部", target: { page: "category", attributes: { category: "", param: null } } },
                    { label: "爱情", target: { page: "category", attributes: { category: "aiqing", param: null } } },
                    { label: "欢乐向", target: { page: "category", attributes: { category: "huanlexiang", param: null } } },
                    { label: "冒险", target: { page: "category", attributes: { category: "maoxian", param: null } } },
                    { label: "奇幻", target: { page: "category", attributes: { category: "qihuan", param: null } } },
                    { label: "百合", target: { page: "category", attributes: { category: "baihe", param: null } } },
                    { label: "校园", target: { page: "category", attributes: { category: "xiaoyuan", param: null } } },
                    { label: "科幻", target: { page: "category", attributes: { category: "kehuan", param: null } } },
                    { label: "東方", target: { page: "category", attributes: { category: "dongfang", param: null } } },
                    { label: "耽美", target: { page: "category", attributes: { category: "danmei", param: null } } },
                    { label: "生活", target: { page: "category", attributes: { category: "shenghuo", param: null } } },
                    { label: "格斗", target: { page: "category", attributes: { category: "gedou", param: null } } },
                    { label: "轻小说", target: { page: "category", attributes: { category: "qingxiaoshuo", param: null } } },
                    { label: "悬疑", target: { page: "category", attributes: { category: "xuanyi", param: null } } },
                    { label: "TL", target: { page: "category", attributes: { category: "teenslove", param: null } } },
                    { label: "萌系", target: { page: "category", attributes: { category: "mengxi", param: null } } },
                    { label: "神鬼", target: { page: "category", attributes: { category: "shengui", param: null } } },
                    { label: "职场", target: { page: "category", attributes: { category: "zhichang", param: null } } },
                    { label: "治愈", target: { page: "category", attributes: { category: "zhiyu", param: null } } },
                    { label: "节操", target: { page: "category", attributes: { category: "jiecao", param: null } } },
                    { label: "四格", target: { page: "category", attributes: { category: "sige", param: null } } },
                    { label: "长条", target: { page: "category", attributes: { category: "changtiao", param: null } } },
                    { label: "舰娘", target: { page: "category", attributes: { category: "jianniang", param: null } } },
                    { label: "搞笑", target: { page: "category", attributes: { category: "gaoxiao", param: null } } },
                    { label: "竞技", target: { page: "category", attributes: { category: "jingji", param: null } } },
                    { label: "偶娘", target: { page: "category", attributes: { category: "weiniang", param: null } } },
                    { label: "魔幻", target: { page: "category", attributes: { category: "mohuan", param: null } } },
                    { label: "热血", target: { page: "category", attributes: { category: "rexue", param: null } } },
                    { label: "性转换", target: { page: "category", attributes: { category: "xingzhuanhuan", param: null } } },
                    { label: "美食", target: { page: "category", attributes: { category: "meishi", param: null } } },
                    { label: "励志", target: { page: "category", attributes: { category: "lizhi", param: null } } },
                    { label: "彩色", target: { page: "category", attributes: { category: "COLOR", param: null } } },
                    { label: "后宮", target: { page: "category", attributes: { category: "hougong", param: null } } },
                    { label: "侦探", target: { page: "category", attributes: { category: "zhentan", param: null } } },
                    { label: "惊悚", target: { page: "category", attributes: { category: "jingsong", param: null } } },
                    { label: "异世界", target: { page: "category", attributes: { category: "yishijie", param: null } } },
                    { label: "战争", target: { page: "category", attributes: { category: "zhanzheng", param: null } } },
                    { label: "历史", target: { page: "category", attributes: { category: "lishi", param: null } } },
                    { label: "机战", target: { page: "category", attributes: { category: "jizhan", param: null } } },
                    { label: "都市", target: { page: "category", attributes: { category: "dushi", param: null } } },
                    { label: "穿越", target: { page: "category", attributes: { category: "chuanyue", param: null } } },
                    { label: "重生", target: { page: "category", attributes: { category: "chongsheng", param: null } } },
                    { label: "恐怖", target: { page: "category", attributes: { category: "kongbu", param: null } } },
                    { label: "生存", target: { page: "category", attributes: { category: "shengcun", param: null } } },
                    { label: "宅系", target: { page: "category", attributes: { category: "zhaixi", param: null } } },
                    { label: "转生", target: { page: "category", attributes: { category: "zhuansheng", param: null } } },
                    { label: "仙侠", target: { page: "category", attributes: { category: "xianxia", param: null } } },
                ]
            }
        ],
        enableRankingPage: true,
    }

    categoryComics = {
        load: async (category, param, options, page) => {
            var baseUrl = this._baseUrl;

            // Ranking mode
            if (category === "排行" || param === "ranking") {
                var audienceType = options && options[0] ? options[0] : "male";
                var dateType = options && options[1] ? options[1] : "day";
                var url = baseUrl + "/rank?type=" + audienceType + "&table=" + dateType;
                var resp = await Network.get(url, { dnts: "3" });
                var body = resp.body;

                var doc = new HtmlDocument(body);
                var items = doc.querySelectorAll(".ranking-all > li");

                var comics = [];
                for (var i = 0; i < items.length; i++) {
                    var el = items[i];
                    var link = el.querySelector("a[href*='/comic/']");
                    if (!link) continue;
                    var href = link.attributes ? link.attributes.href || "" : "";
                    var idMatch = href.match(/\/comic\/([^/]+)/);
                    if (!idMatch) continue;
                    var id = idMatch[1];

                    var titleEl = el.querySelector(".threeLines");
                    var title = titleEl ? titleEl.text.trim() : id;

                    var imgEl = el.querySelector("img");
                    var cover = "";
                    if (imgEl) {
                        cover = imgEl.attributes["data-src"] || imgEl.attributes.src || "";
                    }

                    var authorEl = el.querySelector(".oneLines");
                    var author = "";
                    if (authorEl) {
                        var authorLink = authorEl.querySelector("a");
                        if (authorLink) author = authorLink.text.trim();
                    }

                    comics.push(new Comic({ id: id, title: title, cover: cover, subTitle: author }));
                }

                doc.dispose();
                return { comics: comics, maxPage: 1 };
            }

            // Theme browsing mode
            var region = options && options[0] ? options[0] : "";
            var status = options && options[1] ? options[1] : "";
            var ordering = options && options[2] ? options[2] : "-datetime_updated";
            var url = baseUrl + "/comics?theme=" + encodeURIComponent(category);
            if (region) url += "&region=" + region;
            if (status) url += "&status=" + status;
            url += "&ordering=" + ordering + "&offset=" + offset + "&limit=50";
            var resp = await Network.get(url, { dnts: "3" });

            // Parse comics from list attribute
            var comics = parseExploreList(resp.body);

            // Parse max page from pagination
            var maxPage = parseMaxPage(resp.body);

            return { comics: comics, maxPage: maxPage };
        },
        optionList: [
            {
                label: "地区",
                options: [
                    "-全部",
                    "0-日漫",
                    "1-韩漫",
                    "2-美漫",
                ],
                notShowWhen: ["排行"],
            },
            {
                label: "状态",
                options: [
                    "-全部",
                    "0-连载中",
                    "1-已完结",
                    "2-短篇",
                ],
                notShowWhen: ["排行"],
            },
            {
                label: "排序",
                options: [
                    "-datetime_updated-最新",
                    "-popular-最熱",
                ],
                notShowWhen: ["排行"],
            },
            {
                options: [
                    "male-男频",
                    "female-女频",
                ],
                showWhen: ["排行"],
            },
            {
                options: [
                    "day-日榜",
                    "week-周榜",
                    "month-月榜",
                    "total-总榜",
                ],
                showWhen: ["排行"],
            },
        ],
    }

    search = {
        load: async (keyword, options, page) => {
            var offset = ((page || 1) - 1) * 12;
            var url = this._baseUrl + "/api/kb/web/searchci/comics?offset=" + offset + "&platform=2&limit=12&q="
                + encodeURIComponent(keyword) + "&q_type=";
            var resp = await Network.get(url, { dnts: "3" });
            var json = JSON.parse(resp.body);

            var comics = [];
            if (json.results && json.results.list) {
                comics = json.results.list.map(apiToComic);
            }

            var total = json.results ? json.results.total || 0 : 0;
            var maxPage = Math.ceil(total / 12) || 1;

            return { comics: comics, maxPage: maxPage };
        }
    }

    comic = {
        loadInfo: async (id) => {
            var baseUrl = this._baseUrl;
            var url = baseUrl + "/comic/" + encodeURIComponent(id);
            var resp = await Network.get(url, { dnts: "3" });
            var body = resp.body;

            // Title
            var title = id;
            var titleMatch = body.match(/<h6[^>]*title="([^"]*)"/);
            if (titleMatch) title = titleMatch[1];
            if (!titleMatch) {
                var titleMatch2 = body.match(/<h6[^>]*>([^<]+)<\/h6>/);
                if (titleMatch2) title = titleMatch2[1];
            }

            // Cover
            var cover = "";
            var coverMatch = body.match(/comicParticulars-left-img[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/);
            if (coverMatch) cover = coverMatch[1];

            // Description
            var description = "";
            var descMatch = body.match(/<p class="intro">([\s\S]*?)<\/p>/);
            if (descMatch) description = descMatch[1].trim();

            // Author
            var author = "";
            var authorMatch = body.match(/<a href="\/author\/[^"]+"[^>]*>([^<]+)<\/a>/);
            if (authorMatch) author = authorMatch[1];

            // Tags
            var tagList = [];
            var tagRegex = /<a href="\/comics\?theme=[^"]+"[^>]*>#([^<]+)<\/a>/g;
            var tagMatch;
            while ((tagMatch = tagRegex.exec(body)) !== null) {
                tagList.push(tagMatch[1]);
            }
            // Update time: "最後更新：2026-06-21"
            var updateTime = "";
            var updateMatch = body.match(/(?:最後|最后)更新[：:][\s\S]*?<span[^>]*>([^<]+)<\/span>/);
            if (updateMatch) updateTime = updateMatch[1].trim();

            // Status: "狀態：連載中"
            var statusText = "";
            var statusMatch = body.match(/狀態[：:][\s\S]*?<span[^>]*>([^<]+)<\/span>/);
            if (!statusMatch) statusMatch = body.match(/状态[：:][\s\S]*?<span[^>]*>([^<]+)<\/span>/);
            if (statusMatch) statusText = statusMatch[1].trim();

            // Build tags: genres, update time, status
            var tags = {};
            if (tagList.length > 0) tags["题材"] = tagList;
            if (statusText) tags["状态"] = [statusText];

            // Fetch chapter list from encrypted API
            var chapters = await fetchChapters(id, baseUrl);

            return new ComicDetails({
                title: title,
                cover: cover,
                description: description,
                tags: tags,
                chapters: chapters,
                uploader: author,
                updateTime: updateTime,
            });
        },

        onClickTag: (namespace, tag) => {
            return new PageJumpTarget({
                page: "search",
                attributes: {
                    keyword: tag,
                },
            });
        },

        loadEp: async (comicId, epId) => {
            var url = this._baseUrl + "/comic/" + encodeURIComponent(comicId)
                + "/chapter/" + encodeURIComponent(epId);
            var resp = await Network.get(url, { dnts: "3" });

            // Extract contentKey from HTML
            var match = resp.body.match(/var contentKey = '([^']+)'/);
            if (!match) throw new Error("No contentKey found in chapter page");

            var data = decryptData(match[1]);

            // data is an array of {url: "..."}
            var images = [];
            if (Array.isArray(data)) {
                images = data.map(function (item) { return item.url; });
            }

            return { images: images };
        }
    }

    favorites = {
        multiFolder: false,

        addOrDelFavorite: async (comicId, folderId, isAdding, favoriteId) => {
            var token = this.loadData("token");
            if (!token) throw "登录已过期";

            var uuid = favoriteId || null;

            // If no UUID available, fetch comic detail page to extract it
            if (!uuid) {
                var baseUrl = this._baseUrl;
                var resp = await Network.get(baseUrl + "/comic/" + encodeURIComponent(comicId), { dnts: "3" });
                var uuidMatch = resp.body.match(/onclick="collect\('([^']+)'\)"/);
                if (uuidMatch) uuid = uuidMatch[1];
            }

            if (!uuid) throw "未能获取漫画UUID";

            var res = await Network.post(
                this._baseUrl + "/api/v2/web/collect",
                {
                    "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
                    "Authorization": "Token " + token,
                },
                "comic_id=" + uuid + "&is_collect=" + (isAdding ? "1" : "0")
            );

            var json = JSON.parse(res.body);
            if (json.code === 200) return "ok";

            throw json.message || "收藏失败";
        },

        loadComics: async (page, folder) => {
            var token = this.loadData("token");
            var headers = {};
            if (token) headers["Authorization"] = "Token " + token;

            var offset = ((page || 1) - 1) * 12;
            var url = this._baseUrl + "/api/v3/member/collect/comics?limit=12&offset=" + offset
                + "&free_type=1&ordering=-datetime_modifier";

            var res = await Network.get(url, headers);
            var json = JSON.parse(res.body);

            if (json.code !== 200) {
                if (res.status === 401) throw "登录已过期";
                throw json.message || "加载失败";
            }

            var list = json.results && json.results.list ? json.results.list : [];
            var comics = list.map(function (item) {
                var comic = item.comic || {};
                var author = "";
                if (comic.author && comic.author.length > 0) {
                    author = comic.author[0].name || "";
                }
                return new Comic({
                    id: comic.path_word || "",
                    title: comic.name || "",
                    cover: comic.cover || "",
                    subTitle: author,
                    description: comic.last_chapter_name || "",
                    // Store UUID in favoriteId for add/del operations
                    favoriteId: comic.uuid || null,
                });
            });

            return { comics: comics, maxPage: 999 };
        }
    }

    settings = {
        base_url: {
            title: "API地址",
            type: "input",
            validator: null,
            default: "https://www.copy3000.com"
        }
    }

    translation = {
        "zh_CN": {
            "API地址": "API地址"
        },
        "zh_TW": {
            "API地址": "API地址"
        },
        "en": {
            "API地址": "API Address"
        }
    }
}
