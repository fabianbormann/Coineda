import { Button, Modal, Steps, message } from 'antd';
import { useState } from 'react';

const { Step } = Steps;

const AddTransactionsDialog = (props) => {
  const [step, setStep] = useState(0);

  const next = () => setStep(step + 1);
  const prev = () => setStep(step - 1);

  const steps = [
    {
      title: 'Specify the exchanges or wallets',
      content: 'First-content',
    },
    {
      title: 'Select the transaction kind',
      content: 'Second-content',
    },
    {
      title: 'Add the transaction content',
      content: 'Last-content',
    },
  ];

  return (
    <Modal
      title="Add"
      visible={props.visible}
      onOk={props.onClose}
      onCancel={props.onClose}
    >
      <Steps current={step} direction="vertical">
        {steps.map((item) => (
          <Step key={item.title} title={item.title} />
        ))}
      </Steps>
      <div className="steps-content">{steps[step].content}</div>
      <div className="steps-action">
        {step > 0 && (
          <Button style={{ margin: '0 8px' }} onClick={() => prev()}>
            Previous
          </Button>
        )}
        {step < steps.length - 1 && (
          <Button type="primary" onClick={() => next()}>
            Next
          </Button>
        )}
        {step === steps.length - 1 && (
          <Button
            type="primary"
            onClick={() => message.success('Processing complete!')}
          >
            Done
          </Button>
        )}
      </div>
    </Modal>
  );
};

export default AddTransactionsDialog;
