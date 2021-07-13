import { useTranslation } from 'react-i18next';

const TaxReports = () => {
  const { t } = useTranslation();

  return (
    <div>
      <h1>{t('Tax Reports')}</h1>
    </div>
  );
};

export default TaxReports;
