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
// Venera's decryptAesCbc may not strip PKCS7 padding, so we do it manually.
function decryptData(encrypted) {
    var iv = Convert.encodeUtf8(encrypted.substring(0, 16));
    var ciphertext = hexToBytes(encrypted.substring(16));
    var key = Convert.encodeUtf8(CCZ);
    var decrypted = new Uint8Array(Convert.decryptAesCbc(ciphertext, key, iv));

    // Strip PKCS7 padding
    var padLen = decrypted[decrypted.length - 1];
    if (padLen >= 1 && padLen <= 16) {
        decrypted = decrypted.slice(0, decrypted.length - padLen);
    }

    return JSON.parse(Convert.decodeUtf8(decrypted.buffer));
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
    name = "\u62f7\u8d1d\u6f2b\u753b"
    key = "copy_manga"
    version = "1.4.1"
    minAppVersion = "1.6.0"
    url = ""

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

            // Status
            var statusText = "";
            var statusMatch = body.match(/\u72c0\u614b[\uff1a:]\s*([^<]+)</);
            if (!statusMatch) statusMatch = body.match(/\u72b6\u6001[\uff1a:]\s*([^<]+)</);
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
                updateTime: statusText
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
