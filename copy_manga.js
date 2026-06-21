// ==UserScript==
// @name         拷贝漫画
// @version      1.6.0
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

// Parse HTML-based comic list (used by /recommend and /newest pages)
// These pages render comics as .exemptComic_Item elements
function parseHtmlComicList(html) {
    var doc = new HtmlDocument(html);
    var items = doc.querySelectorAll(".exemptComic_Item");
    var comics = [];
    for (var i = 0; i < items.length; i++) {
        var el = items[i];
        var link = el.querySelector("a[href*='/comic/']");
        if (!link) continue;
        var href = link.attributes ? link.attributes.href || "" : "";
        var idMatch = href.match(/\/comic\/([^/]+)/);
        if (!idMatch) continue;
        var id = idMatch[1];

        var titleEl = el.querySelector(".twoLines");
        var title = titleEl ? titleEl.text.trim() : id;

        var img = el.querySelector("img");
        var cover = img ? (img.attributes["data-src"] || img.attributes.src || "") : "";

        var authorEl = el.querySelector(".exemptComicItem-txt-span a");
        var author = authorEl ? authorEl.text.trim() : "";

        comics.push(new Comic({ id: id, title: title, cover: cover, description: author }));
    }

    doc.dispose();
    return comics;
}

// Parse the embedded list attribute from explore page HTML
// The list attribute contains a JS array literal with single-quoted strings
function parseListAttribute(html) {
    // Find all list="..." occurrences and pick only the one that looks like JSON array
    var regex = /list="([^"]+)"/g;
    var raw = "";
    var m;
    while ((m = regex.exec(html)) !== null) {
        var val = m[1].trim();
        if (val.startsWith("[")) {
            raw = val;
            break;
        }
    }
    if (!raw) return [];
    var decoded = raw
        .replace(/&#x27;/g, "'")
        .replace(/&#34;/g, '\\"')
        .replace(/&quot;/g, '\\"')
        .replace(/&amp;/g, "&");
    var json = decoded.replace(/'/g, '"');
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
        // page-total shows "/254" — actual total page count
        var totalMatch = pageMatch[0].match(/<li[^>]*class="page-total"[^>]*>\s*\/\s*(\d+)\s*<\/li>/);
        if (totalMatch) {
            return parseInt(totalMatch[1]) || 1;
        }
        // Fallback: get max from visible page numbers
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

// ── categoryComics sub-handlers ─────────────────────────────

// Author page: /author/{slug}/comics?offset=&limit=50
async function loadAuthorPage(baseUrl, slug, page) {
    var offset = ((page || 1) - 1) * 50;
    var url = baseUrl + "/author/" + encodeURIComponent(slug) + "/comics?offset=" + offset + "&limit=50";
    var resp = await Network.get(url, { dnts: "3" });
    var body = resp.body;
    var doc = new HtmlDocument(body);
    var items = doc.querySelectorAll(".correlationItem");
    var comics = [];
    for (var i = 0; i < items.length; i++) {
        var el = items[i];
        var link = el.querySelector("a[href*='/comic/']");
        if (!link) continue;
        var href = link.attributes ? link.attributes.href || "" : "";
        var idMatch = href.match(/\/comic\/([^/]+)/);
        if (!idMatch) continue;
        var img = el.querySelector("img");
        var cover = img ? (img.attributes["data-src"] || img.attributes.src || "") : "";
        var titleEl = el.querySelector(".twoLines");
        var title = titleEl ? titleEl.text.trim() : idMatch[1];
        comics.push(new Comic({ id: idMatch[1], title: title, cover: cover }));
    }
    doc.dispose();
    return { comics: comics, maxPage: parseMaxPage(body) };
}

// Explore view-more landing page: generic paginated comic list
async function loadExplorePage(baseUrl, path, pageSize, page, parser) {
    var offset = ((page || 1) - 1) * pageSize;
    var separator = path.indexOf("?") >= 0 ? "&" : "?";
    var url = baseUrl + path + separator + "offset=" + offset + "&limit=" + pageSize;
    var resp = await Network.get(url, { dnts: "3" });
    return { comics: parser(resp.body), maxPage: parseMaxPage(resp.body) };
}

// Ranking page: single-page list from /rank
async function loadRankingPage(baseUrl, options) {
    var audience = options && options[0] ? options[0] : "male";
    var dateRange = options && options[1] ? options[1] : "day";
    var url = baseUrl + "/rank?type=" + audience + "&table=" + dateRange;
    var resp = await Network.get(url, { dnts: "3" });
    var doc = new HtmlDocument(resp.body);
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
        var cover = imgEl ? (imgEl.attributes["data-src"] || imgEl.attributes.src || "") : "";
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

// Theme browsing: /comics?theme={slug} with optional filters
async function loadThemePage(baseUrl, category, param, options, page) {
    var offset = ((page || 1) - 1) * 50;
    var region = options && options[0] ? options[0] : "";
    var status = options && options[1] ? options[1] : "";
    var ordering = { "new": "-datetime_updated", "hot": "-popular" };
    var orderingValue = ordering[options && options[2] ? options[2] : "new"] || "-datetime_updated";
    var themeSlug = param !== null && param !== undefined ? param : category;
    var url = baseUrl + "/comics?theme=" + encodeURIComponent(themeSlug);
    if (region) url += "&region=" + region;
    if (status) url += "&status=" + status;
    url += "&ordering=" + orderingValue + "&offset=" + offset + "&limit=50";
    var resp = await Network.get(url, { dnts: "3" });
    return { comics: parseListAttribute(resp.body), maxPage: parseMaxPage(resp.body) };
}

// ============================================================
// Venera Source
// ============================================================

class CopyManga extends ComicSource {

    name = "拷贝漫画"

    key = "copy_manga"

    version = "1.4.2"

    minAppVersion = "1.6.0"

    url = "https://cdn.jsdelivr.net/gh/venera-app/venera-configs@main/copy_manga.js"

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

    // Calculate pagination offset (0-based)
    _offset(page, pageSize) {
        return ((page || 1) - 1) * pageSize;
    }

    // Extract comic UUID from the detail page for favorites API
    async _fetchFavUuid(comicId) {
        var resp = await Network.get(this._baseUrl + "/comic/" + encodeURIComponent(comicId), { dnts: "3" });
        var m = resp.body.match(/onclick="collect\('([^']+)'\)"/);
        return m ? m[1] : null;
    }

    explore = [
        {
            title: "拷贝漫画",
            type: "multiPartPage",

            /**
             * Load all explore sections at once.
             * @returns {Array<{title: string, comics: Comic[], viewMore: string?}>}
             */
            load: async (page) => {
                var resp = await Network.get(this._baseUrl + "/", { dnts: "3" });
                var html = resp.body;

                var doc = new HtmlDocument(html);
                var icons = doc.querySelectorAll(".index-all-icon");
                var results = [];

                for (var i = 0; i < icons.length; i++) {
                    var icon = icons[i];
                    var titleEl = icon.querySelector(".index-all-icon-left-txt");
                    if (!titleEl) continue;
                    var raw = titleEl.text.trim().replace(/<[^>]+>/g, "").trim();

                    // Map title to canonical section name
                    var name = "";
                    if (raw.indexOf("漫畫") >= 0 && raw.indexOf("推薦") >= 0) name = "漫畫推薦";
                    else if (raw.indexOf("熱門") >= 0) name = "熱門更新";
                    else if (raw.indexOf("全新") >= 0) name = "全新上架";
                    else continue;

                    // Get the parent container for this section
                    var container = icon.parent;
                    if (!container) continue;

                    // Extract comic items from the .row
                    var items = container.querySelectorAll('.col-auto > a[href*="/comic/"]');
                    var comics = [];
                    for (var j = 0; j < items.length; j++) {
                        var a = items[j];
                        var href = a.attributes.href || "";
                        var idMatch = href.match(/\/comic\/([^/]+)/);
                        if (!idMatch) continue;

                        var img = a.querySelector("img");
                        var cover = img ? (img.attributes["data-src"] || img.attributes.src || "") : "";

                        var p = a.querySelector(".edit-txt");
                        var title = p ? p.text.trim() : idMatch[1];

                        comics.push(new Comic({ id: idMatch[1], title: title, cover: cover }));
                    }

                    if (comics.length > 0) {
                        results.push({
                            title: name,
                            comics: comics,
                            viewMore: "category:" + name,
                        });
                    }
                }

                doc.dispose();
                return results;
            }
        }
    ]

    category = {
        title: "拷贝漫画",
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
                    { label: "全部", target: { page: "category", attributes: { category: "全部", param: "" } } },
                    { label: "爱情", target: { page: "category", attributes: { category: "爱情", param: "aiqing" } } },
                    { label: "欢乐向", target: { page: "category", attributes: { category: "欢乐向", param: "huanlexiang" } } },
                    { label: "冒险", target: { page: "category", attributes: { category: "冒险", param: "maoxian" } } },
                    { label: "奇幻", target: { page: "category", attributes: { category: "奇幻", param: "qihuan" } } },
                    { label: "百合", target: { page: "category", attributes: { category: "百合", param: "baihe" } } },
                    { label: "校园", target: { page: "category", attributes: { category: "校园", param: "xiaoyuan" } } },
                    { label: "科幻", target: { page: "category", attributes: { category: "科幻", param: "kehuan" } } },
                    { label: "東方", target: { page: "category", attributes: { category: "東方", param: "dongfang" } } },
                    { label: "耽美", target: { page: "category", attributes: { category: "耽美", param: "danmei" } } },
                    { label: "生活", target: { page: "category", attributes: { category: "生活", param: "shenghuo" } } },
                    { label: "格斗", target: { page: "category", attributes: { category: "格斗", param: "gedou" } } },
                    { label: "轻小说", target: { page: "category", attributes: { category: "轻小说", param: "qingxiaoshuo" } } },
                    { label: "悬疑", target: { page: "category", attributes: { category: "悬疑", param: "xuanyi" } } },
                    { label: "TL", target: { page: "category", attributes: { category: "TL", param: "teenslove" } } },
                    { label: "萌系", target: { page: "category", attributes: { category: "萌系", param: "mengxi" } } },
                    { label: "神鬼", target: { page: "category", attributes: { category: "神鬼", param: "shengui" } } },
                    { label: "职场", target: { page: "category", attributes: { category: "职场", param: "zhichang" } } },
                    { label: "治愈", target: { page: "category", attributes: { category: "治愈", param: "zhiyu" } } },
                    { label: "节操", target: { page: "category", attributes: { category: "节操", param: "jiecao" } } },
                    { label: "四格", target: { page: "category", attributes: { category: "四格", param: "sige" } } },
                    { label: "长条", target: { page: "category", attributes: { category: "长条", param: "changtiao" } } },
                    { label: "舰娘", target: { page: "category", attributes: { category: "舰娘", param: "jianniang" } } },
                    { label: "搞笑", target: { page: "category", attributes: { category: "搞笑", param: "gaoxiao" } } },
                    { label: "竞技", target: { page: "category", attributes: { category: "竞技", param: "jingji" } } },
                    { label: "偶娘", target: { page: "category", attributes: { category: "偶娘", param: "weiniang" } } },
                    { label: "魔幻", target: { page: "category", attributes: { category: "魔幻", param: "mohuan" } } },
                    { label: "热血", target: { page: "category", attributes: { category: "热血", param: "rexue" } } },
                    { label: "性转换", target: { page: "category", attributes: { category: "性转换", param: "xingzhuanhuan" } } },
                    { label: "美食", target: { page: "category", attributes: { category: "美食", param: "meishi" } } },
                    { label: "励志", target: { page: "category", attributes: { category: "励志", param: "lizhi" } } },
                    { label: "彩色", target: { page: "category", attributes: { category: "彩色", param: "COLOR" } } },
                    { label: "后宮", target: { page: "category", attributes: { category: "后宮", param: "hougong" } } },
                    { label: "侦探", target: { page: "category", attributes: { category: "侦探", param: "zhentan" } } },
                    { label: "惊悚", target: { page: "category", attributes: { category: "惊悚", param: "jingsong" } } },
                    { label: "异世界", target: { page: "category", attributes: { category: "异世界", param: "yishijie" } } },
                    { label: "战争", target: { page: "category", attributes: { category: "战争", param: "zhanzheng" } } },
                    { label: "历史", target: { page: "category", attributes: { category: "历史", param: "lishi" } } },
                    { label: "机战", target: { page: "category", attributes: { category: "机战", param: "jizhan" } } },
                    { label: "都市", target: { page: "category", attributes: { category: "都市", param: "dushi" } } },
                    { label: "穿越", target: { page: "category", attributes: { category: "穿越", param: "chuanyue" } } },
                    { label: "重生", target: { page: "category", attributes: { category: "重生", param: "chongsheng" } } },
                    { label: "恐怖", target: { page: "category", attributes: { category: "恐怖", param: "kongbu" } } },
                    { label: "生存", target: { page: "category", attributes: { category: "生存", param: "shengcun" } } },
                    { label: "宅系", target: { page: "category", attributes: { category: "宅系", param: "zhaixi" } } },
                    { label: "转生", target: { page: "category", attributes: { category: "转生", param: "zhuansheng" } } },
                    { label: "仙侠", target: { page: "category", attributes: { category: "仙侠", param: "xianxia" } } },
                ]
            }
        ]
    }

    categoryComics = {
        load: async (category, param, options, page) => {
            var b = this._baseUrl;

            if (param && param.startsWith("author:")) return loadAuthorPage(b, param.slice(7), page);
            if (category === "漫畫推薦") return loadExplorePage(b, "/recommend?type=3200102", 60, page, parseHtmlComicList);
            if (category === "熱門更新") return loadExplorePage(b, "/comics?ordering=-hits_total", 50, page, parseListAttribute);
            if (category === "全新上架") return loadExplorePage(b, "/newest", 60, page, parseHtmlComicList);
            if (category === "排行" || param === "ranking") return loadRankingPage(b, options);

            return loadThemePage(b, category, param, options, page);
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
                notShowWhen: ["排行", "漫畫推薦", "全新上架"],
            },
            {
                label: "状态",
                options: [
                    "-全部",
                    "0-连载中",
                    "1-已完结",
                    "2-短篇",
                ],
                notShowWhen: ["排行", "漫畫推薦", "全新上架"],
            },
            {
                label: "排序",
                options: [
                    "new-最新",
                    "hot-最熱",
                ],
                notShowWhen: ["排行", "漫畫推薦", "全新上架"],
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
            var offset = this._offset(page, 12);
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

            // Authors (name + slug for navigation)
            var authorRegex = /<a href="\/author\/([^"]+)\/comics"[^>]*>([^<]+)<\/a>/g;
            var authorMatch;
            var authors = [];
            var authorSlugs = {};
            while ((authorMatch = authorRegex.exec(body)) !== null) {
                var slug = authorMatch[1];
                var name = authorMatch[2];
                authors.push(name);
                authorSlugs[name] = slug;
            }
            this._authorSlugs = authorSlugs;

            // Tags (theme): store display name + slug mapping for reliable tag click navigation
            var tagList = [];
            var tagSlugs = {};
            var tagRegex = /<a href="\/comics\?theme=([^"]+)"[^>]*>#([^<]+)<\/a>/g;
            var tagMatch;
            while ((tagMatch = tagRegex.exec(body)) !== null) {
                tagList.push(tagMatch[2]);
                tagSlugs[tagMatch[2]] = tagMatch[1];
            }
            this._themeSlugs = tagSlugs;
            // Update time: "最後更新：2026-06-21"
            var updateTime = "";
            var updateMatch = body.match(/(?:最後|最后)更新[：:][\s\S]*?<span[^>]*>([^<]+)<\/span>/);
            if (updateMatch) updateTime = updateMatch[1].trim();

            // Status: "狀態：連載中"
            var statusText = "";
            var statusMatch = body.match(/狀態[：:][\s\S]*?<span[^>]*>([^<]+)<\/span>/);
            if (!statusMatch) statusMatch = body.match(/状态[：:][\s\S]*?<span[^>]*>([^<]+)<\/span>/);
            if (statusMatch) statusText = statusMatch[1].trim();

            // Build tags: genres, authors, status
            var tags = {};
            if (tagList.length > 0) tags["题材"] = tagList;
            if (authors.length > 0) tags["作者"] = authors;
            if (statusText) tags["状态"] = [statusText];

            // Fetch chapter list from encrypted API
            var chapters = await fetchChapters(id, baseUrl);

            return new ComicDetails({
                title: title,
                cover: cover,
                description: description,
                tags: tags,
                chapters: chapters,
                updateTime: updateTime,
            });
        },

        onClickTag: (namespace, tag) => {
            if (namespace === "题材") {
                // 1) Use slug extracted from the comic page HTML (handles Trad/Simp perfectly)
                var slug = this._themeSlugs ? this._themeSlugs[tag] : null;
                if (slug) {
                    return { action: "category", keyword: tag, param: slug };
                }
                // 2) Fallback: look up in the category list by label
                var catPart = this.category.parts.find(function (p) { return p.name === "分类"; });
                if (catPart) {
                    for (var ci = 0; ci < catPart.categories.length; ci++) {
                        var entry = catPart.categories[ci];
                        if (entry.label === tag && entry.target && entry.target.attributes) {
                            return { action: "category", keyword: tag, param: entry.target.attributes.param };
                        }
                    }
                }
            }
            if (namespace === "作者") {
                var slug = this._authorSlugs ? this._authorSlugs[tag] : null;
                if (slug) {
                    return {
                        action: "category",
                        keyword: tag,
                        param: "author:" + slug,
                    };
                }
            }
            return {
                action: "search",
                keyword: tag,
            };
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

            var uuid = favoriteId || await this._fetchFavUuid(comicId);
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

            var offset = this._offset(page, 12);
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
}
