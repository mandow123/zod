export type InquiryProbeRecord = Readonly<{
  path:string;
  status:number;
  contentType:string;
  cacheControl:string|null;
  bytes:number;
}>;

export type InquiryProbeResult = Readonly<{
  origin:string;
  ok:boolean;
  failures:string[];
  records:InquiryProbeRecord[];
  signatures:Record<string,{status:number;contentType:string;service:string|null;apiVersion:string|null;errorCode:string|null}>;
}>;

export const inquiryProbePaths:readonly string[];
export const honghuanCanonicalResourceIds:readonly string[];
export function probeInquiryOrigin(rawOrigin:string,options?:Readonly<{allowExpectedPublicProofBlockers?:boolean}>):Promise<InquiryProbeResult>;
