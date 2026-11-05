# Required task artifacts

In a task's Attachments section, enable **Require a task artifact** and enter the file's path relative to the team's configured project directory, for example `outputs/final.mp4`. The file must already exist. The app records attachment metadata and calculates its size and SHA-256 locally; it does not move or upload the file. An owner can also attach a required artifact with MCP `task_set_artifact_file`, providing `teamName`, `taskId`, `relativePath`, and their `actor` name.

Completion and transitions into review or approval re-read the file and reject a missing, unreadable, or changed artifact. After intentionally changing the result, attach it again to record a new proof. Existing tasks have no artifact requirement by default. The user can turn the requirement off in the task; agents cannot disable it through this tool.

The project must have an explicitly configured absolute project path. Relative paths cannot escape that directory or pass through symbolic links or junctions. Changing the configured project directory invalidates existing proofs. The project-relative file may be larger than the separate 20 MB image-upload limit, so a video can remain in the project directory. Hashing reads in bounded chunks but currently runs synchronously; a large file or slow disk may temporarily block the app or MCP server.

The SHA-256 and size identify the bytes that were read; they do not establish that the result is correct or useful. Checks compare the opened file and its path before and after reading, but they do not make later access to the file atomic or prevent subsequent changes. Consumers must verify again immediately before using it.
