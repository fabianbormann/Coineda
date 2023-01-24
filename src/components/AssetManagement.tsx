import { useState } from 'react';
import axios from 'axios';
import { useTranslation } from 'react-i18next';
import storage from '../persistence/storage';

const AssetManagement = () => {
  const { t } = useTranslation();
  const [searchResults, setSearchResults] = useState([]);
  const [selectedAsset, setSelectedAsset] = useState();
  const [searchText, setSearchText] = useState('');

  /*const onSearch = async (value) => {
    if (value.length > 1) {
      const tokenList = JSON.parse(localStorage.getItem('TOKEN_LIST'));
      let results = [];
      if (tokenList && new Date().getTime() - tokenList.age < 1000 * 60 * 15) {
        results = tokenList.entries.filter(
          (coin) => coin.symbol.toLowerCase() === value.toLowerCase()
        );
      } else {
        try {
          const coins = await axios.get(
            'https://api.coingecko.com/api/v3/coins/list'
          );

          localStorage.setItem(
            'TOKEN_LIST',
            JSON.stringify({ entries: coins.data, age: new Date().getTime() })
          );
          results = coins.data.filter(
            (coin) => coin.symbol.toLowerCase() === value.toLowerCase()
          );
        } catch (error) {
          console.log(error);
        }
      }

      setSearchResults(results);
      if (results.length > 0) {
        setSelectedAsset(results[0].id);
      } else {
        setSelectedAsset();
        message.info(
          `Could not fetch any token or coin having the symbol ${value}`
        );
      }
      setSearchText('');
    }
  };

  const selectAsset = (value) => {
    setSelectedAsset(value);
  };

  const addAsset = async () => {
    const asset = searchResults.find((result) => result.id === selectedAsset);
    try {
      const existingAsset = await storage.assets.get(asset.id);
      if (existingAsset) {
        message.info(
          t(`${asset.name} (${asset.symbol}) is already on your list of assets`)
        );
      } else {
        await storage.assets.add(asset);
        message.success(
          t(
            `Successfully added ${asset.name} (${asset.symbol}) to your asset list`
          )
        );
      }
    } catch (error) {
      message.error(
        'Asset persistence failed. Please restart the application.'
      );
      console.warn(error);
    } finally {
      setSearchText('');
      setSelectedAsset(null);
      setSearchResults([]);
    }
  };

  return (
    <div className={classes.content}>
      <p className={classes.headline}>{t('Asset Management')}</p>
      <p>{t('Asset Explanation')}</p>
      <Search
        placeholder={t('Asset input placeholder')}
        allowClear
        className={classes.search}
        value={searchText}
        onChange={(event) => setSearchText(event.target.value)}
        enterButton={t('Search')}
        onSearch={onSearch}
      />
      {searchResults.length > 0 && (
        <div className={classes.selectionContainer}>
          <Select
            value={selectedAsset}
            onSelect={selectAsset}
            placeholder="Select a token"
            className={classes.selection}
          >
            {searchResults.map((result) => (
              <Option
                key={result.id}
                value={result.id}
              >{`${result.name} (${result.symbol})`}</Option>
            ))}
          </Select>
          <Button type="primary" icon={<PlusOutlined />} onClick={addAsset}>
            {t('Add')}
          </Button>
        </div>
      )}
    </div>
  );*/

  return <div></div>;
};

export default AssetManagement;
