import { Upload, Modal, message } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import { useState } from 'react';
import axios from 'axios';
import { useTranslation } from 'react-i18next';

const { Dragger } = Upload;

const ImportDialog = (props) => {
  const { t } = useTranslation();
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);

  const addFile = (file) => {
    if (file.type !== 'text/csv') {
      message.error(`${file.name} is not a csv file`);
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
      await axios.post('http://localhost:5208/transactions/import', data);
      message.success('upload successfully.');
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
          {t('Click or drag file to this area to upload')}
        </p>
        <p className="ant-upload-hint">
          {t('Support for a single or bulk upload')}
        </p>
      </Dragger>
    </Modal>
  );
};

export default ImportDialog;
