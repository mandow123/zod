import { createRequire } from 'node:module';
import { SendSmsRequest } from '@alicloud/dysmsapi20170525/dist/models/model.js';
import { Config as OpenApiConfig } from '@alicloud/openapi-client';
import type { RuntimeConfig } from '../config.js';

export interface SmsProvider {
  sendOtp(phone: string, code: string): Promise<void>;
}

export class UnavailableSmsProvider implements SmsProvider {
  async sendOtp(): Promise<void> {
    throw new Error('SMS provider is not configured.');
  }
}

export class AliyunSmsProvider implements SmsProvider {
  private readonly client: { sendSms(request: SendSmsRequest): Promise<{ body?: { code?: string } }> };

  constructor(private readonly config: RuntimeConfig) {
    const clientConfig = new OpenApiConfig({
      accessKeyId: config.SMS_ACCESS_KEY_ID,
      accessKeySecret: config.SMS_ACCESS_KEY_SECRET,
    });
    clientConfig.endpoint = 'dysmsapi.aliyuncs.com';
    const require = createRequire(import.meta.url);
    const clientModule = require('@alicloud/dysmsapi20170525') as {
      default: new (value: OpenApiConfig) => { sendSms(request: SendSmsRequest): Promise<{ body?: { code?: string } }> };
    };
    this.client = new clientModule.default(clientConfig);
  }

  async sendOtp(phone: string, code: string) {
    const response = await this.client.sendSms(new SendSmsRequest({
      phoneNumbers: phone.replace(/^\+86/u, ''),
      signName: this.config.SMS_SIGN_NAME,
      templateCode: this.config.SMS_TEMPLATE_CODE,
      templateParam: JSON.stringify({ code }),
    }));
    if (response.body?.code !== 'OK') {
      throw new Error(`Aliyun SMS rejected request: ${response.body?.code ?? 'UNKNOWN'}`);
    }
  }
}

export function createSmsProvider(config: RuntimeConfig): SmsProvider | null {
  if (!config.readiness.capabilities.sms.available) return null;
  if (config.SMS_PROVIDER !== 'aliyun') throw new Error(`Unsupported SMS provider: ${config.SMS_PROVIDER}`);
  return new AliyunSmsProvider(config);
}
