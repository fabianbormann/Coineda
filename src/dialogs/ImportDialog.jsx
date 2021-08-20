import { Upload, Modal, message } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import { useState } from 'react';
import axios from 'axios';
import { useTranslation, Trans } from 'react-i18next';

const { Dragger } = Upload;

const ImportDialog = (props) => {
  const { t } = useTranslation();
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);

  const addFile = (file) => {
    if (file.type !== 'text/csv') {
      message.error(t('is not a csv file', { filename: file.name }));
    } else {
      setFiles([...files, file]);
    }

    return false;
  };

  const handleUpload = async () => {
    const data = new FormData();

    for (const file of files) {
      data.append('files', file);
    }

    try {
      const response = (
        await axios.post('http://localhost:5208/transactions/import', data)
      ).data;

      const { inserts, duplicates, errors } = response;

      if (duplicates === 0 && errors === 0 && inserts > 0) {
        message.success(
          t('Transactions successfully uploaded', { inserts: inserts })
        );
      } else {
        message.warning(t('Transactions partially uploaded', response));
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
