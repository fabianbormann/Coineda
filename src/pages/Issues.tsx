import React from 'react';
import { useTranslation } from 'react-i18next';

const Issues = () => {
  const { t } = useTranslation();

  return (
    <div>
      <p>{t('Issues') as string}</p>
      <div>No issues detected</div>
    </div>
  );
};

export default Issues;
