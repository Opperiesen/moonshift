export const FOUNDATION_MIGRATIONS = [
  Object.freeze({
    version: 1,
    name: 'foundation',
    filename: '001_foundation.sql',
    checksum: '68a98f565058cf66d5cfa0eb49e702708256aeda4d7bb44b4261459402a822b2',
  }),
  Object.freeze({
    version: 2,
    name: 'start-observe',
    filename: '002_start_observe.sql',
    checksum: '41650619ada0b572ae9721cbd8110498c4515c7a51548cd4c5f2f345546eee63',
  }),
  Object.freeze({
    version: 3,
    name: 'verification',
    filename: '003_verification.sql',
    checksum: '6b84c7c62bb30d5d2c190ce6150591120e92c4c24d71db9bb3bdeb0657453cf7',
  }),
] as const;
