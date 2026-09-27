# jake-goldwasser.com

## Bookbug (`bookbug/`)

- The app's name is **Bookbug** — one capital B. Never "BookBug", "Book Bug", or "BookLouse". The lowercase `bookbug` wordmark in the page header is a logo and stays lowercase. This applies everywhere: UI text, `<title>`, comments, commit messages, docs.
- Use these terms consistently in the UI and in conversation: **book title**, **section title**, **entry title**, **entry** (not "poem", "heading", "chapbook", "collection", "body text", or "title page"). Internal identifiers such as `state.poems`, `chapbookId`, and the `chapbookbuilder` cloud key are legacy names; leave them alone rather than renaming stored data.
- A book is either on Home (the book grid, formerly called "My Books"), archived, or permanently deleted. There is no trash. Permanent delete is only offered from the archive.
- Home has two shelves: **My books** and **My picture books**. A picture book is laid out by the spread: a **title page**, numbered **spreads** (each a verso and a recto page, plus illustration notes), and an **end page**, exported as a digital dummy, a printable dummy, or a PowerPoint. It is the old Dummy Builder folded into Bookbug; don't bring Dummy Builder back as a separate tool. Picture books sync as `pictureBooks` / `pictureBookTrash` under the same `chapbookbuilder` cloud key; their saved fields keep Dummy Builder's names (`rows`, `graveyard` = archived spreads), so leave those alone too.
