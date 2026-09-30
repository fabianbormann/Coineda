import { useTranslation } from 'react-i18next';
import { AssetSearch } from '@/components/assets/AssetSearch';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { LanguageSetting } from '@/components/settings/LanguageSetting';
import { AccountList } from '@/components/accounts/AccountList';

const Settings = () => {
  const { t } = useTranslation();

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-6 p-4 md:p-6">
      <SettingsSection
        title={t('General')}
        description={t('Language and regional preferences')}
      >
        <LanguageSetting />
      </SettingsSection>

      <SettingsSection
        title={t('Account Management')}
        description={t('Add, rename or remove the portfolios you track')}
      >
        <AccountList />
      </SettingsSection>

      <SettingsSection
        title={t('Asset Management')}
        description={t('Search for a coin and add it to your tracked assets')}
      >
        <AssetSearch />
      </SettingsSection>
    </div>
  );
};

export default Settings;
