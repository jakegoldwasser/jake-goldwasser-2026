# jake-goldwasser.com

## Bookbug (`bookbug/`)

- The app's name is **Bookbug** — one capital B. Never "BookBug", "Book Bug", or "BookLouse". The lowercase `bookbug` wordmark in the page header is a logo and stays lowercase. This applies everywhere: UI text, `<title>`, comments, commit messages, docs.
- Use these terms consistently in the UI and in conversation: **book title**, **section title**, **entry title**, **entry** (not "poem", "heading", "chapbook", "collection", "body text", or "title page"). Internal identifiers such as `state.poems`, `chapbookId`, and the `chapbookbuilder` cloud key are legacy names; leave them alone rather than renaming stored data.
- A book is either on Home (the book grid, formerly called "My Books"), archived, or permanently deleted. There is no trash. Permanent delete is only offered from the archive.
- Bookbug has two **book types**: **collections** (entries flowed one to a page) and **picture books**. Home shows a shelf per type the person has added ("My collections", "My picture books"; **Add book type** adds the other), so someone making only one kind never sees the other. Preferences are grouped the same way (Everywhere / Collections / Picture books).
- A picture book is laid out by the **spread**: page 1 alone, numbered spreads (a verso and a recto page), and the last page alone, so n spreads make 2n − 2 pages. Pages can have a **role** (title page, copyright, endpaper, pastedown…). Spreads hold free-placed **text boxes** and **pictures**. Exports: digital dummy, printable dummy, PowerPoint. It is the old Dummy Builder folded into Bookbug; don't bring Dummy Builder back as a separate tool.
- While a picture book is open the app uses its blue colorway (`body.view-pb` tokens); collections keep the beige one.
- Picture books sync as `pictureBooks` / `pictureBookTrash` (plus `homeForms`) under the same `chapbookbuilder` cloud key. Their pictures are stored apart, one per item in the `BookbugImages` DynamoDB table via the Lambda's `?image=` routes, and cached in the browser's IndexedDB.
