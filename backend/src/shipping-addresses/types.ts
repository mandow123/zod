export type ShippingAddressRecord = Readonly<{
  id:string; reference:string; subjectId:string; createdByUserId:string; payloadCiphertext:string;
  payloadDigest:string; isDefault:boolean; createdAt:Date; updatedAt:Date;
}>;
export type ShippingAddressPayload = Readonly<{
  recipientName:string; phone:string; province:string; city:string; district:string; detail:string;
}>;
