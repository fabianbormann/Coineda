import { Upload, Modal, message } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import { useState, useContext } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { SettingsContext } from '../SettingsContext';
import { importFiles } from '../helper/import';

const { Dragger } = Upload;

const ImportDialog = (props) => {
  const { t } = useTranslation();
  const [files, setFiles] = useState([]);
  const [settings] = useContext(SettingsContext);
  const { account } = settings;
  const [uploading, setUploading] = useState(false);

  const addFile = (file) => {
    if (
      file.name.endsWith('.cnd') ||
      file.name.endsWith('.xlsx') ||
      file.name.endsWith('.csv')
    ) {
      setFiles([...files, file]);
    } else {
      const parts = file.name.split('.');
      message.error(
        t('File type is not supported', { fileType: parts[parts.length - 1] })
      );
    }

    return false;
  };

  const handleUpload = async () => {
    try {
      const { inserts, duplicates, errors } = await importFiles(
        files,
        account.id
      );

      if (duplicates === 0 && errors === 0 && inserts > 0) {
        message.success(
          t('Transactions successfully uploaded', { inserts: inserts })
        );
      } else {
        message.warning(
          t('Transactions partially uploaded', { inserts, duplicates, errors })
        );
      }

      setFiles([]);
      props.onClose();
    } catch (error) {
      message.error('upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const submit = () => {
    if (!uploading) {
      setUploading(true);
      handleUpload();
    }
  };

  return (
    <Modal
      visible={props.visible}
      onOk={submit}
      okButtonProps={{
        disabled: files.length < 1 || uploading,
        loading: uploading,
      }}
      onCancel={() => props.onClose()}
    >
      <Dragger
        multiple={true}
        onRemove={(file) =>
          setFiles(files.filter((element) => element !== file))
        }
        beforeUpload={addFile}
        fileList={files}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">
          <Trans i18nKey="UploadFieldText">
            Click or drag file to this area to upload
          </Trans>
        </p>
        <p className="ant-upload-hint">
          <Trans i18nKey="UploadFieldHint">
            Support for a single or bulk upload
          </Trans>
        </p>
      </Dragger>
    </Modal>
  );
};

export default ImportDialog;
