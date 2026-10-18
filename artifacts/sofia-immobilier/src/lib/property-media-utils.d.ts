export type PropertyImageFileLike = Pick<File, 'type' | 'size'>;

export declare const MAX_PROPERTY_IMAGE_SIZE: number;
export declare const SUPPORTED_PROPERTY_IMAGE_TYPES: ReadonlySet<string>;

export declare function validatePropertyImage(file: PropertyImageFileLike): void;
export declare function propertyImageFileName(name: string): string;
export declare function propertyImageObjectPath(
  agencyId: string,
  propertyId: string,
  fileName: string,
  objectId?: string,
): string;
export declare function propertyStorageUploadFailureAction(error: unknown):
  | 'do-not-clean'
  | 'cleanup-possible-object';
export declare function propertyDeleteFailureAction(input: {
  rowFound: boolean;
  verificationFailed: boolean;
  errorCode?: unknown;
}): 'preserve-error' | 'treat-as-deleted';
export declare function propertyMediaDeleteStorageAction(input: {
  targetMediaId: string;
  linkedMediaIds?: string[];
  verificationFailed: boolean;
}):
  | 'preserve-for-review'
  | 'preserve-linked-metadata'
  | 'keep-referenced-object'
  | 'remove-unlinked-object';
export declare function propertyMediaInsertFailureAction(input: {
  rowFound: boolean;
  verificationFailed: boolean;
  insertErrorCode?: unknown;
}): 'registered' | 'cleanup-orphan' | 'preserve-for-review';
