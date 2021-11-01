import { useState, useContext } from 'react';
import axios from 'axios';
import { message, Input, Select, Button } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { createUseStyles } from 'react-jss';
import { useTranslation } from 'react-i18next';
import { SettingsContext } from '../SettingsContext';

const { Search } = Input;
const { Option } = Select;

const useStyles = createUseStyles({
  content: {
    display: 'flex',
    flexDirection: 'column',
  },
  search: {
    width: 300,
  },
  selection: {
    width: '50%',
    minWidth: 300,
    marginRight: 6,
  },
  selectionContainer: {
    display: 'flex',
    alignItems: 'center',
    marginTop: 12,
    flexWrap: 'wrap',
  },
  headline: {
    marginBottom: 12,
    marginTop: 0,
    fontWeight: 500,
    fontSize: '1.1rem',
    color: '#2F4858',
  },
});

const AssetManagement = () => {
  const [settings] = useContext(SettingsContext);
  const classes = useStyles();
  const { t } = useTranslation();
  const [searchResults, setSearchResults] = useState([]);
  const [selectedAsset, setSelectedAsset] = useState();
  const [searchText, setSearchText] = useState('');
  const { backendUrl } = settings;

  const onSearch = async (value) => {
    if (value.length > 1) {
      const response = await axios.get(`${backendUrl}/assets/search/${value}`);
      setSearchResults(response.data);
      if (response.data.length > 0) {
        setSelectedAsset(response.data[0].id);
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
      const response = await axios.post(`${backendUrl}/assets`, {
        asset: asset,
      });
      if (response.status === 203) {
        message.info(
          t(`${asset.name} (${asset.symbol}) is already on your list of assets`)
        );
      } else if (response.status === 200) {
        message.success(
          t(
            `Successfully added ${asset.name} (${asset.symbol}) to your asset list`
          )
        );
      }
    } catch (error) {
      message.error(
        'Coineda backend is not available. Please restart the application.'
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
      <p>
        Not all assets were added by default because the selection menu would be
        overloaded with the number of available tokens. However, you can easily
        search and add missing assets.
      </p>
      <Search
        placeholder="input a symbol e.g. btc"
        allowClear
        className={classes.search}
        value={searchText}
        onChange={(event) => setSearchText(event.target.value)}
        enterButton="Search"
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
  );
};

export default AssetManagement;
