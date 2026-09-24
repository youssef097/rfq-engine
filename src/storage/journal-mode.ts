export type DiskJournalMode = "wal" | "delete";

/**
 * Enable WAL only when SQLite includes the WAL-reset corruption fix.
 * Unknown version formats use the rollback journal. The two older release
 * branches received explicit backports; intermediate branches did not.
 * https://sqlite.org/wal.html#walresetbug
 */
export function diskJournalMode(sqliteVersion: string): DiskJournalMode {
  if (
    typeof sqliteVersion !== "string" ||
    sqliteVersion.length > 64 ||
    sqliteVersion.trim() !== sqliteVersion ||
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(sqliteVersion)
  )
    return "delete";
  const [major, minor, patch] = sqliteVersion.split(".").map(Number);
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    ![major, minor, patch].every(Number.isSafeInteger)
  )
    return "delete";
  const fixed =
    major > 3 ||
    (major === 3 &&
      (minor > 51 ||
        (minor === 51 && patch >= 3) ||
        (minor === 50 && patch >= 7) ||
        (minor === 44 && patch >= 6)));
  return fixed ? "wal" : "delete";
}
