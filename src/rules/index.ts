import { ANDROID_RULES } from './android';
import { IOS_RULES } from './ios';
import { WEB_RULES } from './web';

export type RulesPreset = 'android' | 'ios' | 'web' | 'custom' | '';

export function getPresetRules(preset: RulesPreset): string {
  switch (preset) {
    case 'android':
      return ANDROID_RULES;
    case 'ios':
      return IOS_RULES;
    case 'web':
      return WEB_RULES;
    default:
      return '';
  }
}


