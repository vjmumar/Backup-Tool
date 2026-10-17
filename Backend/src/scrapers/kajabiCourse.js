
window.__courseBackup.scrape = async (onProgress) => {
    const report = (text) => { try { onProgress?.(text); } catch (_) { } };

    // First, get the site id from the URL
    const siteId = location.href
        .split("https://app.kajabi.com/admin/sites/")[1]
        .split("/")[0];

    /**
     * Then, get the course list.
     * Walk the paginated courses table until the "Next page" button is disabled.
     * Result: [{ text, link }]
     */
    const courses = await new Promise(async (resolve) => {
        let array = [];
        let page = 1;
        let isLast = false;
        while (!isLast) {
            // First, fetch one page of the courses table and parse it as HTML
            report("Reading course list…");
            const doc = await fetch(`/admin/sites/${siteId}/courses?page=${page}`)
                .then((e) => e.text())
                .then((e) => {
                    const parser = new DOMParser();
                    return parser.parseFromString(e, "text/html");
                });

            // Then, check if this is the last page (the "Next page" button is disabled)
            const disabledNextButton = doc.querySelector(
                'pds-button[data-turbo-frame="data_table_product"][aria-label="Next page"][disabled]',
            );
            // Then, collect the title and link of every course on this page
            const courseLinks = Array.from(
                doc.querySelectorAll(
                    "pds-table[component-id = 'table-product'] a[href *= '/admin/products/'][data-shell-frame-linker-target='link']",
                ),
            ).slice(0, 3).reduce((a, c) => {
                const image = c.querySelector("img");
                a.push({
                    text: c.innerText,
                    link: c.href,
                    image: image.src,
                });
                return a;
            }, []);
            array.push(...courseLinks);

            // Finally, stop on the last page, otherwise move on to the next page
            if (page === 1) {
                isLast = true;
                resolve(array);
                break;
            }
            page++;
        }
    });

    /**
     * Then, for each course:
     * get its categories and posts, get the details of every post,
     * and put each post inside its category.
     */
    const coursesWithCategoriesAndPost = await new Promise(async (resolve) => {
        let array = [];
        for (let i = 0; i < courses.length; i++) {
            const current = courses[i];
            // First, get the course id (the last part of /admin/products/<id>)
            const categoryId = current.link.split("/").slice(-1)[0];
            report(`Course ${i + 1} of ${courses.length}: ${current.text}`);
            // Then, get the categories of the course
            const categories = await fetch(
                `https://app.kajabi.com/api/admin/products/${categoryId}/categories`,
                {
                    method: "GET",
                    headers: {
                        Authorization: window.validationToken,
                    },
                },
            )
                .then((e) => e.json())
                .then((e) => e.data);

            // Then, get all the posts of the course
            const posts = await fetch(
                `https://app.kajabi.com/api/admin/products/${categoryId}/posts`,
                {
                    method: "GET",
                    headers: {
                        Authorization: window.validationToken,
                    },
                },
            )
                .then((e) => e.json())
                .then((e) => e.data);

            // Then we will retrieve the full details of every posts
            for (let p = 0; p < posts.length; p++) {
                const post = posts[p];
                report(`Course ${i + 1} of ${courses.length}: ${current.text} — lesson ${p + 1} of ${posts.length}`);
                const postData = await fetch(
                    `https://app.kajabi.com/api/admin/posts/${post.id}`,
                    {
                        method: "GET",
                        headers: {
                            Authorization: window.validationToken,
                        },
                    },
                ).then((e) => e.json());
                const postDownloads = await fetch(
                    `https://app.kajabi.com/api/admin/posts/${post.id}/downloads`,
                    {
                        method: "GET",
                        headers: {
                            Authorization: window.validationToken,
                        },
                    },
                ).then((e) => e.json());
                postData.downloads = postDownloads?.data || [];
                posts[p] = postData || {};
            }

            // Then, put each post inside the category it belongs to (category.posts)
            categories.forEach((ec) => {
                posts.forEach((ep) => {
                    if (ec.id === ep.data.relationships.category.data.id) {
                        ec.posts = [...(ec.posts || []), ep];
                    }
                });
            });

            // Finally, save the course together with its categories
            array.push({
                ...current,
                categories,
            });
        }
        resolve(array);
    });

    /**
     * Takes what the scraper returns and keeps only what the backup needs.
     * Result: course > categories > posts, each with only the fields we use.
     * Every level also gets a files array: a shortcut to check the size of its files.
     * The files stay in their own place too, the shortcut only points to the same links.
     */
    const scrapeParser = (scraped) => {
        // First, one shortcut entry for a file: { type, name, url, fileId }
        // fileId is a stable incrementing ID unique within this scrape session.
        // It is used by the dashboard to stamp sizes and download statuses directly
        // onto the correct file object without relying on URL matching.
        let _fileSeq = 0;
        const toFile = (type, url, name) =>
            url && { type, name: name || url.split("?")[0].split("/").pop(), url, fileId: `f${++_fileSeq}` };

        // Then, go through every course
        return scraped.map(({ text, link, image, categories }) => ({
            text,
            link,
            image,
            // The course files: just its image
            files: [toFile("image", image)].filter(Boolean),
            // Then, keep only the category fields we need, they live inside attributes
            categories: categories.map(({ attributes, posts }) => ({
                courseType: attributes.courseType,
                isHidden: attributes.isHidden,
                position: attributes.position,
                title: attributes.title,
                description: attributes.description,
                posterImageUrl: attributes.posterImageUrl,
                publishing: attributes.publishing,
                publishAtDate: attributes.publishAtDate,
                // The category files: just its thumbnail
                files: [toFile("thumbnail", attributes.posterImageUrl)].filter(Boolean),
                posts: (posts || []).map((post) => {
                    const { data, included = [], downloads = [] } = post;
                    return {
                        id: data.id,
                        title: data.attributes.title,
                        publishing: data.attributes.publishing,
                        body: data.attributes.body,
                        posterImageUrl: data.attributes.posterImageUrl,
                        // The video (and quiz) in included and the downloads, both outside data
                        included: included.map(({ id, type, attributes }) => ({
                            id,
                            type,
                            downloadUrl: attributes.urls?.downloadUrl,
                        })),
                        downloads: downloads.map(({ type, attributes }) => ({
                            name: attributes.name,
                            type,
                            assetUrl: attributes.assetUrl,
                        })),
                        // Finally, the post files: thumbnail, videos and downloads
                        files: [
                            toFile("thumbnail", data.attributes.posterImageUrl),
                            ...included.map(
                                ({ type, attributes }) =>
                                    type === "video" &&
                                    toFile("video", attributes.urls?.downloadUrl),
                            ),
                            ...downloads.map(({ attributes }) =>
                                toFile("download", attributes.assetUrl, attributes.name),
                            ),
                        ].filter(Boolean),
                    };
                }),
            })),
        }));
    };

    // Finally, print the result
    return scrapeParser(coursesWithCategoriesAndPost);
};
