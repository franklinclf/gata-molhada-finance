/** The source fed by card statements the owner uploads as PDF files. It has no adapter: nothing reads it on a schedule. */
export const PDF_SOURCE = 'pdf';

/** Sources the owner feeds by hand, with no adapter. They are never retired at boot, so their records stay live and cannot be purged by mistake. */
export const MANUAL_IMPORT_SOURCES: readonly string[] = [PDF_SOURCE];
