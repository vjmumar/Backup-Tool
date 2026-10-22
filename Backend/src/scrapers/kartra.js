
window.__courseBackup.scrape = async (onProgress) => {
    const report = (text) => { try { onProgress?.(text); } catch (_) { } };

    // Global file sequence — increments across every file in every post in every course
    // so each fileId is unique for the entire scrape session
    let _fileSeq = 0;

    /**
     * First, fetch all courses from the paginated memberships API.
     * Walk pages until the response returns an empty data array.
     * Result: [{ id, ... }]
     */
    const courses = await new Promise(async (resolve) => {
        let array = [];
        let page = 1;
        let isLast = false;
        while (!isLast) {
            report("Reading course list…");
            const coursesRes = await fetch(
                `https://app.kartra.com/api-internal/memberships?page=${page}&per-page=20&campaign-id=0&sort=id&sort-direction=DESC&extra=membership-analytics`,
                { headers: { accept: "*/*", "accept-language": "en-US,en;q=0.9", "cache-control": "no-cache", pragma: "no-cache", priority: "u=1, i" }, body: null, method: "GET" }
            ).then((e) => e.json());

            if (coursesRes?.data?.length) {
                array.push(...coursesRes.data);
                ++page;
            } else {
                isLast = true;
                resolve(array);
            }
        }
    });

    /**
     * Then, for each course:
     * parse its sitemap into a category tree, fetch the welcome post,
     * resolve every post's full content, and attach everything to the course object.
     */
    for (let i = 0; i < courses.length; i++) {
        const course = courses[i];
        report(`Course ${i + 1} of ${courses.length}: ${course.attributes.name}`);

        /**
         * Turns the Kartra sitemap HTML into a structured category tree.
         * Result: [{ id, name, subcategories: [{ id, name, posts: [{ id, name }] }], posts: [{ id, name }] }]
         * Kartra keeps a category's direct posts inside a placeholder subcategory with id -1,
         * so those posts are lifted into the category's own posts list instead.
         */
        const sitemapParser = (html) => {
            // First, parse the sitemap HTML into a document
            const doc = new DOMParser().parseFromString(html || "", "text/html");

            // Then, set up a helper that normalises whitespace in any text node
            const cleanName = (text) => (text || "").replace(/\s+/g, " ").trim();

            // Then, set up a helper that reads one post's id and name
            const toPost = (postEl) => ({
                id: Number(postEl.getAttribute("data-item_id")),
                name: cleanName(postEl.querySelector(".js_post_name")?.textContent),
            });

            // Then, set up a helper that reads a subcategory's name without its progress badge and expand arrow
            const getSubcategoryName = (subEl) => {
                const nameEl = subEl.querySelector(".navigation_first_child_name");
                if (!nameEl) return "";
                const clone = nameEl.cloneNode(true);
                clone.querySelectorAll(".nav_progress_wrapper, .nav_expand_arrow, a").forEach((el) => el.remove());
                return cleanName(clone.textContent);
            };

            // Then, set up a check that filters out the placeholder subcategory (id -1)
            const isRealSubcategory = (subEl) => Number(subEl.getAttribute("data-item_id")) > 0;

            // Finally, read each category with its real subcategories and its own direct posts
            return [...doc.querySelectorAll("div[data-category_id]")].map((categoryEl) => {
                const subEls = [...categoryEl.querySelectorAll('li[data-item_type="subcategory"]')];
                return {
                    id: Number(categoryEl.getAttribute("data-category_id")),
                    name: cleanName(categoryEl.querySelector(".navigation_category_name")?.textContent),
                    subcategories: subEls.filter(isRealSubcategory).map((subEl) => ({
                        id: Number(subEl.getAttribute("data-item_id")),
                        name: getSubcategoryName(subEl),
                        posts: [...subEl.querySelectorAll('li[data-type="post"][data-item_id]')].map(toPost),
                    })),
                    posts: [...categoryEl.querySelectorAll('li[data-type="post"][data-item_id]')]
                        .filter((postEl) => {
                            const parentSub = postEl.closest('li[data-item_type="subcategory"]');
                            return !parentSub || !isRealSubcategory(parentSub);
                        })
                        .map(toPost),
                };
            });
        };

        // First, fetch the course sitemap HTML
        const courseSitemap = await fetch(
            `https://app.kartra.com/memberships/all-memberships/sitemap?search=&membership_site_id=${course.id}`,
            { headers: { accept: "*/*", "accept-language": "en-US,en;q=0.9", "cache-control": "no-cache", pragma: "no-cache" }, body: null, method: "GET" }
        ).then((e) => e.json());

        // Then, fetch the welcome post for the course
        const welcomePost = await fetch(
            `https://app.kartra.com/api-internal/memberships/${course.id}/getCategoriesStructure`,
            { headers: { accept: "*/*", "accept-language": "en-US,en;q=0.9", "cache-control": "no-cache", pragma: "no-cache", priority: "u=1, i" }, body: null, method: "GET" }
        )
            .then((e) => e.json())
            .then((e) => e.data[0].attributes.structure.home);

        // Then, attach the welcome post and the parsed category tree to the course
        course.categories = [
            { id: 0, name: "Welcome", subcategories: [], posts: [welcomePost] },
            ...sitemapParser(courseSitemap.html),
        ];

        /**
         * Takes a raw Kartra post object and turns it into ordered blocks with a matching files list.
         * Result: { id, name, blocks: [{ type, ... }], files: [{ type, url, path, ... }] }
         * Each block's fileIndex points into the files array when the block needs a download.
         */
        const postParser = async (post) => {
            // First, set up the allowed HTML tags, text helpers, and URL utilities
            const ALLOWED_TAGS = ["P", "BR", "STRONG", "B", "EM", "I", "U", "UL", "OL", "LI", "A", "IMG", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE"];

            const clean = (text) => (text || "").replace(/[​﻿]/g, "").replace(/[ \t ]+/g, " ").trim();

            const safeFileName = (name) => clean(name).replace(/[\\/:*?"<>|]+/g, "-").slice(0, 120) || "file";

            const getExt = (url, fallback) => {
                const match = (url || "").split("?")[0].match(/\.([a-z0-9]{2,5})$/i);
                return match ? match[1].toLowerCase() : fallback;
            };

            const toFullUrl = (link) => {
                if (!link) return "";
                try { return new URL(link, "https://app.kartra.com").href; } catch { return link; }
            };

            // Then, set up helpers that sanitise HTML into clean markup and plain text
            const cleanTextHtml = (el) => {
                const clone = el.cloneNode(true);
                clone.querySelectorAll("grammarly-extension, script, style").forEach((junk) => junk.remove());
                [...clone.querySelectorAll("*")].reverse().forEach((node) => {
                    if (!ALLOWED_TAGS.includes(node.tagName)) node.replaceWith(...node.childNodes);
                });
                clone.querySelectorAll("*").forEach((node) => {
                    const href = node.tagName === "A" ? node.getAttribute("href") : null;
                    const src = node.tagName === "IMG" ? node.getAttribute("src") : null;
                    [...node.attributes].forEach((attr) => node.removeAttribute(attr.name));
                    if (href && !href.startsWith("javascript:")) node.setAttribute("href", toFullUrl(href));
                    if (src) node.setAttribute("src", src);
                });
                return clone.innerHTML.replace(/[​﻿]/g, "").trim();
            };

            const toPlainText = (el) => {
                const clone = el.cloneNode(true);
                clone.querySelectorAll("grammarly-extension, script, style").forEach((junk) => junk.remove());
                clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
                clone.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6").forEach((block) => block.append("\n"));
                return clone.textContent.split("\n").map(clean).filter(Boolean).join("\n");
            };

            // Then, set up the result object, counters, and file helpers
            const result = { id: Number(post.id), name: clean(post.name), blocks: [], files: [] };
            const count = { video: 0, image: 0, audio: 0 };
            const usedNames = new Set();

            const addFile = (file) => { result.files.push({ ...file, fileId: `f${++_fileSeq}` }); return result.files.length - 1; };

            const addImageFile = (url) => {
                count.image += 1;
                const path = `lessonFiles/image-${count.image}.${getExt(url, "jpg")}`;
                return { fileIndex: addFile({ type: "image", url, path }), path };
            };

            /**
             * Fetches a Kartra video player page and reads every video in its playlist.
             * Returns [{ name, url }], or an empty list when the page has no video source.
             */
            const resolveKartraVideos = async (playerUrl) => {
                try {
                    // First, fetch the player page as plain text
                    const html = await fetch(playerUrl).then((res) => res.text());

                    // Then, read every playlist item's name and first source
                    const items = [...html.matchAll(/name\s*:\s*['"]([^'"]*)['"]\s*,\s*mediaid[\s\S]*?sources\s*:\s*\[\s*\{\s*src\s*:\s*['"]([^'"]+)['"]/g)]
                        .map((match) => ({ name: clean(match[1]), url: match[2] }));

                    // Then, fall back to the sources alone if the names can't be read
                    const videos = items.length
                        ? items
                        : [...html.matchAll(/sources\s*:\s*\[\s*\{\s*src\s*:\s*['"]([^'"]+)['"]/g)].map((match) => ({ name: "", url: match[1] }));

                    // Finally, return the MP4 links with any escaped slashes fixed, without duplicates
                    const seen = new Set();
                    return videos
                        .map((video) => ({ ...video, url: video.url.replace(/\\\//g, "/") }))
                        .filter((video) => !seen.has(video.url) && seen.add(video.url));
                } catch {
                    return [];
                }
            };

            /**
             * Fetches a Kartra audio embed page and reads every file in its playlist.
             * Returns [{ name, url }], or an empty list when the page has no files.
             */
            const resolveKartraAudios = async (audioId) => {
                try {
                    // First, fetch the audio embed page as plain text
                    const html = await fetch(`https://app.kartra.com/audio/embed/${audioId}`).then((res) => res.text());

                    // Then, read the jsVars JSON that holds the playlist
                    const match = html.match(/window\.jsVars\s*=\s*(\{[\s\S]*?\});\s*<\/script>/) || html.match(/window\.jsVars\s*=\s*(\{[\s\S]*?\});/);
                    const files = match ? JSON.parse(match[1]).audio_playlist_files || [] : [];

                    // Finally, return each file's name and MP3 link
                    return files.filter((file) => file?.sources?.src).map((file) => ({ name: clean(file.name), url: file.sources.src }));
                } catch {
                    return [];
                }
            };

            /**
             * Reads a download's real file name from its Content-Disposition header.
             * Only the headers are read; the request stops before the file body downloads.
             * Returns "" when the name can't be read.
             */
            const getRemoteFileName = async (url) => {
                try {
                    // First, start the request and stop it as soon as the headers arrive
                    const controller = new AbortController();
                    const res = await fetch(url, { signal: controller.signal });
                    controller.abort();

                    // Then, read the file name from Content-Disposition (filename= or filename*=UTF-8'')
                    const header = res.headers.get("content-disposition") || "";
                    const match = header.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);

                    // Finally, return the decoded name
                    return match ? decodeURIComponent(match[1].trim()) : "";
                } catch {
                    return "";
                }
            };

            /**
             * Turns Kartra's download size text ("2.40 MB") into bytes, like a Content-Length.
             * Kartra's MB is MiB (1024 × 1024). Returns null when the text can't be read.
             */
            const kartraSizeToBytes = (text) => {
                // First, read the number and the unit
                const match = String(text || "").match(/([\d.]+)\s*(B|KB|MB|GB)/i);
                if (!match) return null;

                // Then, convert it using 1024-based units
                const units = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

                // Finally, return whole bytes
                return Math.round(Number(match[1]) * units[match[2].toUpperCase()]);
            };

            const addEmbed = (el) => {
                const tag = el.querySelector("iframe, embed");
                if (!tag) return;
                const url = toFullUrl(tag.getAttribute("src"));
                result.blocks.push({ type: "embed", url, html: url ? "" : tag.outerHTML });
            };

            // Then, skip deleted posts early
            if (post.deleted_at) return result;

            // Then, parse the post HTML and collect only the top-level blocks
            const doc = new DOMParser().parseFromString(post.content || "", "text/html");
            const blocks = [...doc.querySelectorAll("[td_type]")].filter((block) => !block.parentElement.closest("[td_type]"));

            // Then, map each block type to its output representation
            for (const block of blocks) {
                const type = block.getAttribute("td_type");

                if (["text", "headline", "highlight"].includes(type)) {
                    let imageCount = 0;
                    block.querySelectorAll("img").forEach((img) => {
                        const url = toFullUrl(img.getAttribute("src") || img.getAttribute("data-cke-saved-src"));
                        if (!url) { img.remove(); return; }
                        const { path } = addImageFile(url);
                        img.setAttribute("src", `./${path}`);
                        imageCount += 1;
                    });
                    const text = toPlainText(block);
                    if (text || imageCount) result.blocks.push({ type: "text", html: cleanTextHtml(block), text });
                    continue;
                }

                if (type === "video") {
                    const videoId = block.getAttribute("data-video");
                    if (block.getAttribute("data-video_source") === "kartra" && videoId) {
                        // Kartra-hosted video: fetch its player page and add every video in its playlist
                        const playerUrl = `https://app.kartra.com/video_front/portal_video/${videoId}`;
                        const videos = await resolveKartraVideos(playerUrl);

                        // When nothing could be resolved, keep the player page so the downloader can retry it
                        const list = videos.length ? videos : [{ name: "", url: playerUrl, unresolved: true }];

                        for (const video of list) {
                            count.video += 1;
                            const fileIndex = addFile({
                                type: "video",
                                url: video.url,
                                path: `lessonFiles/video-${count.video}.${getExt(video.unresolved ? "" : video.url, "mp4")}`,
                                name: video.name,
                                ...(video.unresolved ? { unresolved: true } : {}),
                            });
                            result.blocks.push({ type: "video", fileIndex });
                        }
                    } else {
                        // External video (YouTube, Vimeo, etc.): keep it as an embed
                        addEmbed(block);
                    }
                    continue;
                }

                if (type === "image") {
                    const url = toFullUrl(block.getAttribute("data-image_url") || block.querySelector("img")?.getAttribute("src"));
                    if (!url) continue;
                    const { fileIndex } = addImageFile(url);
                    result.blocks.push({ type: "image", fileIndex });
                    continue;
                }

                if (type === "audio") {
                    // Kartra audio: the block only holds a playlist id, so fetch the playlist for its files
                    const audioId = block.querySelector("[data-kt-type='audio'][data-kt-value]")?.getAttribute("data-kt-value");
                    const audios = audioId
                        ? await resolveKartraAudios(audioId)
                        : [{ name: "", url: toFullUrl(block.querySelector("audio, source")?.getAttribute("src") || block.querySelector("a[href]")?.getAttribute("href")) }];

                    // Then, add each audio file in playlist order
                    for (const audio of audios) {
                        if (!audio.url) continue;
                        count.audio += 1;
                        const fileIndex = addFile({
                            type: "audio",
                            url: audio.url,
                            path: `lessonFiles/audio-${count.audio}.${getExt(audio.url, "mp3")}`,
                            name: audio.name,
                        });
                        result.blocks.push({ type: "audio", fileIndex });
                    }
                    continue;
                }

                if (type === "download" || type === "resource") {
                    for (const item of block.querySelectorAll("[data-download_id]")) {
                        const link = item.querySelector("a[href]")?.getAttribute("href");
                        if (!link) continue;
                        const url = toFullUrl(link);

                        // When the name has no extension, take it from the download's Content-Disposition header
                        let displayName = clean(item.textContent);
                        if (!/\.[a-z0-9]{2,5}$/i.test(displayName)) {
                            const ext = (await getRemoteFileName(url)).match(/\.([a-z0-9]{2,5})$/i)?.[1];
                            if (ext) displayName = `${displayName}.${ext.toLowerCase()}`;
                        }

                        // Deduplicate file names by prefixing the download id when there is a clash
                        const name = safeFileName(displayName);
                        const fileName = usedNames.has(name) ? `${item.getAttribute("data-download_id")}-${name}` : name;
                        usedNames.add(fileName);
                        const fileIndex = addFile({
                            type: "download",
                            url,
                            path: `downloads/${fileName}`,
                            name: displayName,
                            fallbackSize: kartraSizeToBytes(item.getAttribute("data-size")),
                        });
                        result.blocks.push({ type: "download", fileIndex });
                    }
                    continue;
                }

                if (type === "divider") {
                    result.blocks.push({ type: "divider" });
                    continue;
                }

                if (type === "code") {
                    // Code blocks are only captured when they contain an embed
                    addEmbed(block);
                }
            }

            // Finally, return the ordered blocks and the files list
            return result;
        };

        // Then, set up a helper that fetches and parses a single post by id
        const postResolver = async (postId) => {
            report(`Course ${i + 1} of ${courses.length}: ${course.attributes.name} — resolving post ${postId}`);
            const res = await fetch(
                "https://app.kartra.com/memberships/all-memberships/get_membership_site_content_post",
                {
                    headers: {
                        accept: "*/*",
                        "accept-language": "en-US,en;q=0.9",
                        "cache-control": "no-cache",
                        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                        pragma: "no-cache",
                        priority: "u=1, i",
                        "x-requested-with": "XMLHttpRequest",
                    },
                    body: `id=${postId}`,
                    method: "POST",
                }
            ).then((e) => e.json());
            return postParser(res);
        };

        // Finally, resolve every post in every category and subcategory
        for (const category of course.categories) {
            if (category.posts?.length) {
                for (const post of category.posts) {
                    post.data = await postResolver(post.id);
                }
            }
            if (category.subcategories?.length) {
                for (const subC of category.subcategories) {
                    for (const post of subC.posts) {
                        post.data = await postResolver(post.id);
                    }
                }
            }
        }
    }

    // Finally, return the courses
    return courses;
};
