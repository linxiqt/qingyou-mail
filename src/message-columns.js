// Keep MIME blobs off the ordinary reading and mutation paths. Large attachments
// are loaded only through explicit raw/download endpoints.
export const messageColumns = (prefix = "") =>
  [
    "id",
    "owner_id",
    "folder",
    "previous_folder",
    "from_email",
    "from_name",
    "to_json",
    "cc_json",
    "bcc_json",
    "subject",
    "body_text",
    "body_html",
    "snippet",
    "size",
    "is_read",
    "starred",
    "delivery_status",
    "message_id",
    "created_at",
    "trashed_at",
  ]
    .map((name) => prefix + name)
    .join(",");
