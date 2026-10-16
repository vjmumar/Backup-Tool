# Scraper Output Contract

Every scraper must return the same structure so the extension and backup engine can process any platform without platform-specific logic.

---

## Top-level Shape

A scraper returns an **array of courses**.

```ts
Course[]
```

---

## Course

```ts
{
  text: string;           // Course title
  link: string;           // URL to the course admin page
  image: string;          // Course cover image URL
  files: File[];          // Shortcut list — contains just the course cover image
  categories: Category[];
}
```

---

## Category

```ts
{
  courseType: string;
  isHidden: boolean;
  position: number;
  title: string;
  description: string;
  posterImageUrl: string;
  publishing: string;
  publishAtDate: string | null;
  files: File[];          // Shortcut list — contains just the category thumbnail
  posts: Post[];
}
```

---

## Post

```ts
{
  id: string;
  title: string;
  publishing: string;
  body: string;
  posterImageUrl: string;
  included: Included[];   // Videos, quizzes, or other embedded content
  downloads: Download[];  // Attached downloadable files
  files: File[];          // Shortcut list — thumbnail + videos + downloads
}
```

---

## Included (embedded content)

```ts
{
  id: string;
  type: string;           // e.g. "video", "quiz"
  downloadUrl: string;    // Direct download URL (videos only, others may be empty)
}
```

---

## Download (attached file)

```ts
{
  name: string;           // File name
  type: string;           // Asset type
  assetUrl: string;       // Direct URL to the file
}
```

---

## File (shortcut entry)

Every `files` array at the course, category, and post level is a flat shortcut list of all downloadable assets at that level. It is used by the dashboard to measure sizes and track download status without walking the full tree.

```ts
{
  fileId: string;         // Stable unique ID within a scrape session e.g. "f1", "f2"
  type: string;           // "image" | "thumbnail" | "video" | "download"
  name: string;           // Filename derived from the URL, or the original asset name
  url: string;            // Direct URL to fetch the asset
}
```

`fileId` is a sequentially assigned ID (e.g. `f1`, `f2`, …) that is unique within a single scrape session. The dashboard stamps file sizes and download statuses onto these IDs directly.

---

## Full Example

```json
[
  {
    "text": "My Course",
    "link": "https://app.kajabi.com/admin/products/123",
    "image": "https://cdn.example.com/cover.jpg",
    "files": [
      { "fileId": "f1", "type": "image", "name": "cover.jpg", "url": "https://cdn.example.com/cover.jpg" }
    ],
    "categories": [
      {
        "courseType": "online_course",
        "isHidden": false,
        "position": 1,
        "title": "Module 1",
        "description": "Intro module",
        "posterImageUrl": "https://cdn.example.com/module1.jpg",
        "publishing": "published",
        "publishAtDate": null,
        "files": [
          { "fileId": "f2", "type": "thumbnail", "name": "module1.jpg", "url": "https://cdn.example.com/module1.jpg" }
        ],
        "posts": [
          {
            "id": "456",
            "title": "Lesson 1",
            "publishing": "published",
            "body": "<p>Lesson content</p>",
            "posterImageUrl": "https://cdn.example.com/lesson1.jpg",
            "included": [
              { "id": "789", "type": "video", "downloadUrl": "https://cdn.example.com/video.mp4" }
            ],
            "downloads": [
              { "name": "worksheet.pdf", "type": "attachment", "assetUrl": "https://cdn.example.com/worksheet.pdf" }
            ],
            "files": [
              { "fileId": "f3", "type": "thumbnail", "name": "lesson1.jpg", "url": "https://cdn.example.com/lesson1.jpg" },
              { "fileId": "f4", "type": "video", "name": "video.mp4", "url": "https://cdn.example.com/video.mp4" },
              { "fileId": "f5", "type": "download", "name": "worksheet.pdf", "url": "https://cdn.example.com/worksheet.pdf" }
            ]
          }
        ]
      }
    ]
  }
]
```

---

## Rules for New Scrapers

1. Always return `Course[]` — even if the platform calls them something else (products, programs, etc.)
2. Every level (course, category, post) must include a `files` array as a flat shortcut to its assets
3. `fileId` values must be unique within the scrape session — use a shared incrementing counter (see `kajabiCourse.js` for the `_fileSeq` pattern)
4. Fields that don't exist on the source platform should be set to `null` or `""` rather than omitted — this keeps the shape consistent
5. `url` in every `File` must be a direct fetchable URL, not a page link
