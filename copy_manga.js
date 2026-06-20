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

        if (results.token) cookies.push(new Cookie({name: "token", value: results.token, domain: domain}));
        if (results.user_id) cookies.push(new Cookie({name: "user_id", value: results.user_id, domain: domain}));
        if (results.nickname) cookies.push(new Cookie({name: "name", value: results.nickname, domain: domain}));
        if (results.avatar) cookies.push(new Cookie({name: "avatar", value: results.avatar, domain: domain}));
        if (results.datetime_created) cookies.push(new Cookie({name: "create", value: results.datetime_created, domain: domain}));
        if (results.comic_vip) cookies.push(new Cookie({name: "comic_vip", value: String(results.comic_vip), domain: domain}));
        if (results.cartoon_vip) cookies.push(new Cookie({name: "cartoon_vip", value: String(results.cartoon_vip), domain: domain}));

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

        loginWithCookies: {
            fields: [
                "token",
                "user_id",
                "sessionid",
                "csrftoken"
            ],
            validate: async (values) => {
                var baseUrl = "https://www.copy3000.com";

                // Set all cookies before validating
                var cookies = [
                    new Cookie({name: "token", value: values[0], domain: ".copy3000.com"}),
                    new Cookie({name: "user_id", value: values[1], domain: ".copy3000.com"}),
                ];
                if (values[2]) cookies.push(new Cookie({name: "sessionid", value: values[2], domain: "www.copy3000.com"}));
                if (values[3]) cookies.push(new Cookie({name: "csrftoken", value: values[3], domain: "www.copy3000.com"}));

                Network.setCookies(baseUrl, cookies);

                // Validate by fetching user info
                try {
                    var res = await Network.get(baseUrl + "/api/v2/web/user/info", {});
                    var json = JSON.parse(res.body);
                    if (json.code === 200 && json.results) {
                        return true;
                    }
                } catch (e) {
                    // fall through
                }
                return false;
            }
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
            title: "\u6700\u65b0",
            type: "multiPageComicList",
            load: async (page) => {
                var url = this._baseUrl + "/comics?ordering=-datetime_updated&page=" + (page || 1);
                var resp = await Network.get(url, { dnts: "3" });
                var comics = parseExploreList(resp.body);
                return { comics: comics, maxPage: 999 };
            }
        },
        {
            title: "\u70ed\u95e8",
            type: "multiPageComicList",
            load: async (page) => {
                var url = this._baseUrl + "/comics?ordering=-hits_total&page=" + (page || 1);
                var resp = await Network.get(url, { dnts: "3" });
                var comics = parseExploreList(resp.body);
                return { comics: comics, maxPage: 999 };
            }
        }
    ]

    category = {
        title: "\u9898\u6750",
        parts: [
            {
                name: "\u5206\u7c7b",
                type: "fixed",
                categories: [
                    { label: "\u5168\u90e8", target: { page: "category", attributes: { category: "", param: null } } },
                    { label: "\u7231\u60c5", target: { page: "category", attributes: { category: "aiqing", param: null } } },
                    { label: "\u6b22\u4e50\u5411", target: { page: "category", attributes: { category: "huanlexiang", param: null } } },
                    { label: "\u5192\u9669", target: { page: "category", attributes: { category: "maoxian", param: null } } },
                    { label: "\u5947\u5e7b", target: { page: "category", attributes: { category: "qihuan", param: null } } },
                    { label: "\u767e\u5408", target: { page: "category", attributes: { category: "baihe", param: null } } },
                    { label: "\u6821\u56ed", target: { page: "category", attributes: { category: "xiaoyuan", param: null } } },
                    { label: "\u79d1\u5e7b", target: { page: "category", attributes: { category: "kehuan", param: null } } },
                    { label: "\u6771\u65b9", target: { page: "category", attributes: { category: "dongfang", param: null } } },
                    { label: "\u803d\u7f8e", target: { page: "category", attributes: { category: "danmei", param: null } } },
                    { label: "\u751f\u6d3b", target: { page: "category", attributes: { category: "shenghuo", param: null } } },
                    { label: "\u683c\u6597", target: { page: "category", attributes: { category: "gedou", param: null } } },
                    { label: "\u8f7b\u5c0f\u8bf4", target: { page: "category", attributes: { category: "qingxiaoshuo", param: null } } },
                    { label: "\u60ac\u7591", target: { page: "category", attributes: { category: "xuanyi", param: null } } },
                    { label: "TL", target: { page: "category", attributes: { category: "teenslove", param: null } } },
                    { label: "\u840c\u7cfb", target: { page: "category", attributes: { category: "mengxi", param: null } } },
                    { label: "\u795e\u9b3c", target: { page: "category", attributes: { category: "shengui", param: null } } },
                    { label: "\u804c\u573a", target: { page: "category", attributes: { category: "zhichang", param: null } } },
                    { label: "\u6cbb\u6108", target: { page: "category", attributes: { category: "zhiyu", param: null } } },
                    { label: "\u8282\u64cd", target: { page: "category", attributes: { category: "jiecao", param: null } } },
                    { label: "\u56db\u683c", target: { page: "category", attributes: { category: "sige", param: null } } },
                    { label: "\u957f\u6761", target: { page: "category", attributes: { category: "changtiao", param: null } } },
                    { label: "\u8230\u5a18", target: { page: "category", attributes: { category: "jianniang", param: null } } },
                    { label: "\u641e\u7b11", target: { page: "category", attributes: { category: "gaoxiao", param: null } } },
                    { label: "\u7ade\u6280", target: { page: "category", attributes: { category: "jingji", param: null } } },
                    { label: "\u5076\u5a18", target: { page: "category", attributes: { category: "weiniang", param: null } } },
                    { label: "\u9b54\u5e7b", target: { page: "category", attributes: { category: "mohuan", param: null } } },
                    { label: "\u70ed\u8840", target: { page: "category", attributes: { category: "rexue", param: null } } },
                    { label: "\u6027\u8f6c\u6362", target: { page: "category", attributes: { category: "xingzhuanhuan", param: null } } },
                    { label: "\u7f8e\u98df", target: { page: "category", attributes: { category: "meishi", param: null } } },
                    { label: "\u52b1\u5fd7", target: { page: "category", attributes: { category: "lizhi", param: null } } },
                    { label: "\u5f69\u8272", target: { page: "category", attributes: { category: "COLOR", param: null } } },
                    { label: "\u540e\u5bae", target: { page: "category", attributes: { category: "hougong", param: null } } },
                    { label: "\u4fa6\u63a2", target: { page: "category", attributes: { category: "zhentan", param: null } } },
                    { label: "\u60ca\u609a", target: { page: "category", attributes: { category: "jingsong", param: null } } },
                    { label: "\u5f02\u4e16\u754c", target: { page: "category", attributes: { category: "yishijie", param: null } } },
                    { label: "\u6218\u4e89", target: { page: "category", attributes: { category: "zhanzheng", param: null } } },
                    { label: "\u5386\u53f2", target: { page: "category", attributes: { category: "lishi", param: null } } },
                    { label: "\u673a\u6218", target: { page: "category", attributes: { category: "jizhan", param: null } } },
                    { label: "\u90fd\u5e02", target: { page: "category", attributes: { category: "dushi", param: null } } },
                    { label: "\u7a7f\u8d8a", target: { page: "category", attributes: { category: "chuanyue", param: null } } },
                    { label: "\u91cd\u751f", target: { page: "category", attributes: { category: "chongsheng", param: null } } },
                    { label: "\u6050\u6016", target: { page: "category", attributes: { category: "kongbu", param: null } } },
                    { label: "\u751f\u5b58", target: { page: "category", attributes: { category: "shengcun", param: null } } },
                    { label: "\u5b85\u7cfb", target: { page: "category", attributes: { category: "zhaixi", param: null } } },
                    { label: "\u8f6c\u751f", target: { page: "category", attributes: { category: "zhuansheng", param: null } } },
                    { label: "\u4ed9\u4fa0", target: { page: "category", attributes: { category: "xianxia", param: null } } },
                ]
            }
        ],
        enableRankingPage: false,
    }

    categoryComics = {
        load: async (category, param, options, page) => {
            var offset = ((page || 1) - 1) * 50;
            var ordering = options && options[0] ? options[0] : "-datetime_updated";
            var url = this._baseUrl + "/comics?theme=" + encodeURIComponent(category)
                + "&ordering=" + ordering
                + "&offset=" + offset + "&limit=50";
            var resp = await Network.get(url, { dnts: "3" });
            var comics = parseExploreList(resp.body);
            return { comics: comics, maxPage: 999 };
        },
        optionList: [
            {
                label: "\u6392\u5e8f",
                options: [
                    "-datetime_updated-\u6700\u65b0",
                    "-popular-\u6700\u71b1",
                ]
            }
        ],
        ranking: {
            options: [
                "day-\u65e5\u699c",
                "week-\u5468\u699c",
                "month-\u6708\u699c",
                "total-\u7e3d\u699c",
            ],
            load: async (option, page) => {
                var url = this._baseUrl + "/rank?type=male&table=" + option;
                var resp = await Network.get(url, { dnts: "3" });
                var body = resp.body;

                // Parse ranking HTML: extract comic cards
                var doc = new HtmlDocument(body);
                var items = doc.querySelectorAll(".row .comicParticulars-right a[href*='/comic/']");
                if (!items || items.length === 0) {
                    // Fallback: look for any links containing /comic/
                    items = doc.querySelectorAll("a[href*='/comic/']");
                }

                var comics = [];
                var seen = {};
                for (var i = 0; i < items.length; i++) {
                    var el = items[i];
                    var href = el.attributes ? el.attributes.href || "" : "";
                    var idMatch = href.match(/\/comic\/([^/]+)/);
                    if (!idMatch) continue;
                    var id = idMatch[1];
                    if (seen[id]) continue;
                    seen[id] = true;

                    var titleEl = el.querySelector("p") || el;
                    var title = titleEl ? titleEl.text.trim() : id;

                    var imgEl = el.querySelector("img");
                    var cover = "";
                    if (imgEl) {
                        cover = imgEl.attributes["data-src"] || imgEl.attributes.src || "";
                    }

                    comics.push(new Comic({
                        id: id,
                        title: title,
                        cover: cover,
                    }));
                }

                doc.dispose();

                return { comics: comics, maxPage: 1 };
            }
        }
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
            var tags = tagList.length > 0 ? { "\u9898\u6750": tagList } : null;

            // Update time: "最後更新：2026-06-21"
            var updateTime = "";
            var updateMatch = body.match(/\u6700\u540e\u66f4\u65b0[\uff1a:]\s*[^>]*>([^<]+)</);
            if (updateMatch) updateTime = updateMatch[1].trim();

            // Status: "狀態：連載中"
            var statusText = "";
            var statusMatch = body.match(/\u72c0\u614b[\uff1a:]\s*[^>]*>([^<]+)</);
            if (!statusMatch) statusMatch = body.match(/\u72b6\u6001[\uff1a:]\s*[^>]*>([^<]+)</);
            if (statusMatch) statusText = statusMatch[1].trim();

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
                // Pass status as subtitle for display
                subTitle: statusText,
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
            if (!token) throw "\u767b\u5f55\u5df2\u8fc7\u671f";

            var uuid = favoriteId || null;

            // If no UUID available, fetch comic detail page to extract it
            if (!uuid) {
                var baseUrl = this._baseUrl;
                var resp = await Network.get(baseUrl + "/comic/" + encodeURIComponent(comicId), { dnts: "3" });
                var uuidMatch = resp.body.match(/onclick="collect\('([^']+)'\)"/);
                if (uuidMatch) uuid = uuidMatch[1];
            }

            if (!uuid) throw "\u672a\u80fd\u83b7\u53d6\u6f2b\u753bUUID";

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

            throw json.message || "\u6536\u85cf\u5931\u8d25";
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
                if (res.status === 401) throw "\u767b\u5f55\u5df2\u8fc7\u671f";
                throw json.message || "\u52a0\u8f7d\u5931\u8d25";
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
            title: "API\u5730\u5740",
            type: "input",
            validator: null,
            default: "https://www.copy3000.com"
        }
    }

    translation = {
        "zh_CN": {
            "API\u5730\u5740": "API\u5730\u5740"
        },
        "zh_TW": {
            "API\u5730\u5740": "API\u5730\u5740"
        },
        "en": {
            "API\u5730\u5740": "API Address"
        }
    }
}
