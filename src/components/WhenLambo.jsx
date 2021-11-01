import { Progress, Image } from 'antd';
import { createUseStyles } from 'react-jss';

const useStyles = createUseStyles({
  wrapper: {
    backgroundColor: 'white',
    padding: 16,
    marginTop: 1,
    marginBottom: 1,
    color: 'rgba(0, 0, 0, 0.45)',
    fontSize: 14,
    fontVariant: 'tabular-nums',
  },
  container: {
    display: 'flex',
    alignItems: 'center',
  },
  image: {
    display: 'flex',
    justifyContent: 'flex-end',
  },
  space: {
    width: 32,
  },
  progress: {
    '& > .ant-progress-text': {
      color: 'rgba(0, 0, 0, 0.45) !important',
      fontSize: 14,
    },
  },
});

const WhenLambo = (props) => {
  const classes = useStyles();
  const goal = 219000;
  const percent = Math.min(Math.round((props.value / goal) * 10000) / 100, 100);

  return (
    <div className={classes.wrapper}>
      <span>When Lambo?</span>
      <div className={classes.container}>
        <Progress percent={percent} className={classes.progress} />
        <div className={classes.space} />
        <Image
          className={classes.image}
          preview={false}
          style={{ maxWidth: 100 }}
          src={'/assets/lamborghini.svg'}
        />
      </div>
    </div>
  );
};

export default WhenLambo;
